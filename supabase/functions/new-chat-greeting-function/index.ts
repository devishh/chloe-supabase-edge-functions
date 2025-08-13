// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";

// GROQ Configuration
const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_TEMPERATURE = 1.0;
const GROQ_MAX_TOKENS = 2048;
const GROQ_TOP_P = 1.0;
const GROQ_REASONING_EFFORT = "medium";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req) => {
    console.log("Function called with method:", req.method);
    
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        console.log("Handling CORS preflight");
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only handle POST requests
    if (req.method !== "POST") {
        console.log("Method not allowed:", req.method);
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });
    }

    try {
        console.log("Starting function execution");
        const authHeader = req.headers.get("Authorization");
        console.log("Auth header present:", !!authHeader);
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        // Auth check
        if (!authHeader?.startsWith("Bearer ")) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const token = authHeader.replace("Bearer ", "");
        console.log("Token extracted, length:", token.length);
        
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        console.log("Auth getUser result:", { hasData: !!userData, hasError: !!userErr, userId: userData?.user?.id });
        
        if (userErr || !userData?.user) {
            console.log("Auth failed:", userErr);
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }
        const userId = userData.user.id;
        console.log("User authenticated, ID:", userId);

        // Use authed client for DB writes
        const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // Get user's preferred name
        let preferredName: string | null = null;
        console.log("Fetching user profile...");
        try {
            const { data: profile, error: profileError } = await db
                .from("profiles")
                .select("preferred_name")
                .eq("id", userId)
                .maybeSingle();
            console.log("Profile fetch result:", { hasProfile: !!profile, preferredName: profile?.preferred_name, error: profileError });
            preferredName = profile?.preferred_name ?? null;
        } catch (error) { 
            console.log("Profile fetch error:", error);
        }

        // Create chat session
        console.log("Creating chat session...");
        const { data: newSession, error: sessionErr } = await db
            .from("chat_session")
            .insert({ user_id: userId })
            .select("id")
            .single();

        console.log("Session creation result:", { hasSession: !!newSession, sessionId: newSession?.id, error: sessionErr });

        if (sessionErr || !newSession?.id) {
            console.log("Session creation failed:", sessionErr);
            return new Response(JSON.stringify({ error: "Failed to create session" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const sessionId: string = newSession.id;
        console.log("Chat session created, ID:", sessionId);

        // Get system prompt and generate greeting with GROQ
        let messageText: string;

        // Retrieve system prompt
        console.log("Fetching system prompt...");
        const { data: promptData, error: promptError } = await db
            .from("prompts")
            .select("content")
            .eq("key", "system_prompt")
            .eq("is_active", true)
            .single();

        console.log("System prompt result:", { hasPrompt: !!promptData, hasContent: !!promptData?.content, error: promptError });

        if (!promptData?.content) {
            console.log("System prompt not found or empty");
            return new Response(JSON.stringify({ error: "System prompt not found" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Use pure system prompt without user context
        const systemPrompt = promptData.content;

        // Send to GROQ
        console.log("Calling GROQ API...");
        const groqRequest = {
            model: GROQ_MODEL,
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                                    {
                        role: "user",
                        content: `Start the session by greeting me warmly using my name once. Never say nice to meet you or something similar. My name is ${preferredName || "there"}`
                    }
            ],
            temperature: GROQ_TEMPERATURE,
            max_completion_tokens: GROQ_MAX_TOKENS,
            top_p: GROQ_TOP_P,
            reasoning_effort: GROQ_REASONING_EFFORT,
            stream: false
        };
        console.log("GROQ request JSON:", JSON.stringify(groqRequest, null, 2));
        
        const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(groqRequest)
        });

        console.log("GROQ response status:", groqResponse.status);

        if (!groqResponse.ok) {
            console.log("GROQ API failed with status:", groqResponse.status);
            return new Response(JSON.stringify({ error: "GROQ API request failed" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const groqData = await groqResponse.json();
        console.log("GROQ response data:", { hasChoices: !!groqData.choices, choiceCount: groqData.choices?.length });
        console.log("GROQ raw response JSON:", JSON.stringify(groqData, null, 2));
        
        const aiResponse = groqData.choices?.[0]?.message?.content?.trim();
        console.log("AI response extracted:", { hasResponse: !!aiResponse, responseLength: aiResponse?.length });
        
        if (!aiResponse) {
            console.log("GROQ returned empty response");
            return new Response(JSON.stringify({ error: "GROQ returned empty response" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        messageText = aiResponse;
        console.log("Message text set:", messageText.substring(0, 100) + "...");

        // Insert assistant message
        console.log("Inserting assistant message...");
        const { error: msgErr } = await db.from("chat_message").insert({
            session_id: sessionId,
            role: "assistant",
            content: { text: messageText }
        });

        console.log("Message insertion result:", { hasError: !!msgErr, error: msgErr });

        if (msgErr) {
            console.log("Message insertion failed:", msgErr);
            // Cleanup empty session
            try { await db.from("chat_session").delete().eq("id", sessionId); } catch (_) { }
            return new Response(JSON.stringify({ error: "Failed to write message" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const payload = {
            session_id: sessionId,
            assistant_text: messageText,
            assistant_message_id: null,
            name_used: preferredName
        };

        // Log the response payload before returning
        console.log("Response payload:", JSON.stringify(payload, null, 2));

        return new Response(JSON.stringify(payload), {
            status: 201,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });

    } catch (error) {
        console.error("Edge function error:", error);
        console.log("Returning error response");
        return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });
    }
});
