// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";

// GROQ Configuration
const GROQ_MODEL = "llama3-8b-8192";
const GROQ_TOP_P = 0.9;
const GROQ_MAX_TOKENS = 150;
const GROQ_REASONING_EFFORT = "medium";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only handle POST requests
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });
    }

    try {
        const authHeader = req.headers.get("Authorization");
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        // Auth check
        if (!authHeader?.startsWith("Bearer ")) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const token = authHeader.replace("Bearer ", "");
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData?.user) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }
        const userId = userData.user.id;

        // Use authed client for DB writes
        const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // Get user's preferred name
        let preferredName: string | null = null;
        try {
            const { data: profile } = await db
                .from("profiles")
                .select("preferred_name")
                .eq("id", userId)
                .maybeSingle();
            preferredName = profile?.preferred_name ?? null;
        } catch (_) { }

        // Create chat session
        const { data: newSession, error: sessionErr } = await db
            .from("chat_session")
            .insert({ user_id: userId })
            .select("id")
            .single();

        if (sessionErr || !newSession?.id) {
            return new Response(JSON.stringify({ error: "Failed to create session" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const sessionId: string = newSession.id;

        // Get system prompt and generate greeting with GROQ
        let messageText = "Hello! How can I help today?"; // fallback

        try {
            // Retrieve system prompt
            const { data: promptData } = await db
                .from("system_prompts")
                .select("content")
                .eq("key", "greeting_new")
                .eq("is_active", true)
                .single();

            if (promptData?.content) {
                // Prepare prompt with user's preferred name if available
                const userContext = preferredName ? `User's preferred name: ${preferredName}` : "No preferred name available";
                const fullPrompt = `${promptData.content}\n\n${userContext}`;

                // Send to GROQ
                const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${GROQ_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: GROQ_MODEL,
                        messages: [
                            {
                                role: "system",
                                content: fullPrompt
                            }
                        ],
                        max_tokens: GROQ_MAX_TOKENS,
                        top_p: GROQ_TOP_P,
                        reasoning_effort: GROQ_REASONING_EFFORT
                    })
                });

                if (groqResponse.ok) {
                    const groqData = await groqResponse.json();
                    const aiResponse = groqData.choices?.[0]?.message?.content?.trim();
                    if (aiResponse) {
                        messageText = aiResponse;
                    }
                }
            }
        } catch (error) {
            console.error("GROQ or prompt retrieval error:", error);
            // Keep fallback message if anything fails
        }

        // Insert assistant message
        const { error: msgErr } = await db.from("chat_message").insert({
            session_id: sessionId,
            role: "assistant",
            content: { text: messageText }
        });

        if (msgErr) {
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

        return new Response(JSON.stringify(payload), {
            status: 201,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });

    } catch (error) {
        console.error("Edge function error:", error);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });
    }
});