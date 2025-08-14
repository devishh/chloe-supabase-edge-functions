// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

// ============================================================================
// CONFIGURABLE PARAMETERS
// ============================================================================

// Database Configuration
const MESSAGE_HISTORY_LIMIT = 40; // Number of messages to fetch (20 pairs)
const SYSTEM_PROMPT_KEY = "system_prompt"; // Key for system prompt in prompts table

// GROQ Configuration
const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_TEMPERATURE = 1.0;
const GROQ_MAX_TOKENS = 2048;
const GROQ_TOP_P = 1.0;
const GROQ_REASONING_EFFORT = "medium";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// User Greeting Configuration
const GREETING_MESSAGE_TEMPLATE = "I am back in the chat. Please pick up the conversation where we left off and greet me warmly using my name once. My name is {name}";
const DEFAULT_NAME_FALLBACK = "there";

// Environment Variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";

// CORS Configuration
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface RequestBody {
    chat_session_id: string;
}

interface ResponseBody {
    chat_session_id: string;
    chat_message_id: string;
    role: "assistant";
    content: string;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

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

        // Use authed client for DB operations
        const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // Parse request body
        const requestBody: RequestBody = await req.json();
        console.log("Request body:", JSON.stringify(requestBody, null, 2));

        const { chat_session_id } = requestBody;

        if (!chat_session_id) {
            console.log("Missing chat_session_id in request body");
            return new Response(JSON.stringify({ error: "Missing chat_session_id" }), {
                status: 400,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        console.log("Chat session ID:", chat_session_id);

        // Verify chat session belongs to user
        const { data: sessionData, error: sessionError } = await db
            .from("chat_session")
            .select("id, user_id")
            .eq("id", chat_session_id)
            .single();

        if (sessionError || !sessionData || sessionData.user_id !== userId) {
            console.log("Session verification failed:", sessionError);
            return new Response(JSON.stringify({ error: "Invalid chat session" }), {
                status: 400,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        console.log("Chat session verified, ID:", chat_session_id);

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

        // Retrieve system prompt
        console.log("Fetching system prompt...");
        const { data: promptData, error: promptError } = await db
            .from("prompts")
            .select("content")
            .eq("key", SYSTEM_PROMPT_KEY)
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

        const systemPrompt = promptData.content;

        // Fetch last messages from database
        console.log(`Fetching last ${MESSAGE_HISTORY_LIMIT} messages from database...`);
        const { data: dbMessages, error: messagesError } = await db
            .from("chat_message")
            .select("id, content, role, created_at")
            .eq("session_id", chat_session_id)
            .order("created_at", { ascending: true })
            .limit(MESSAGE_HISTORY_LIMIT);

        if (messagesError) {
            console.log("Failed to fetch messages:", messagesError);
            return new Response(JSON.stringify({ error: "Failed to fetch conversation history" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        console.log("Fetched messages from database:", { 
            messageCount: dbMessages?.length,
            firstMessage: dbMessages?.[0]?.role,
            lastMessage: dbMessages?.[dbMessages.length - 1]?.role
        });

        // Convert to GROQ format and add system prompt
        const groqMessages = [
            {
                role: "system",
                content: systemPrompt
            },
            ...(dbMessages || []).map(msg => ({
                role: msg.role,
                content: msg.content
            })),
            {
                role: "user",
                content: GREETING_MESSAGE_TEMPLATE.replace("{name}", preferredName || DEFAULT_NAME_FALLBACK)
            }
        ];

        console.log("GROQ messages:", JSON.stringify(groqMessages, null, 2));

        // Send to GROQ
        console.log("Calling GROQ API...");
        const groqRequest = {
            model: GROQ_MODEL,
            messages: groqMessages,
            temperature: GROQ_TEMPERATURE,
            max_completion_tokens: GROQ_MAX_TOKENS,
            top_p: GROQ_TOP_P,
            reasoning_effort: GROQ_REASONING_EFFORT,
            stream: false
        };
        console.log("GROQ request JSON:", JSON.stringify(groqRequest, null, 2));

        const groqResponse = await fetch(GROQ_API_URL, {
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

        // Save assistant response to chat_message table
        console.log("Saving assistant message to database...");
        const { data: messageData, error: msgErr } = await db
            .from("chat_message")
            .insert({
                session_id: chat_session_id,
                role: "assistant",
                content: aiResponse
            })
            .select("id")
            .single();

        console.log("Message insertion result:", { hasData: !!messageData, messageId: messageData?.id, error: msgErr });

        if (msgErr || !messageData?.id) {
            console.log("Message insertion failed:", msgErr);
            return new Response(JSON.stringify({ error: "Failed to save message" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Prepare response in llm-chat-handler format
        const responseBody: ResponseBody = {
            chat_session_id: chat_session_id,
            chat_message_id: messageData.id,
            role: "assistant",
            content: aiResponse
        };

        console.log("Response payload:", JSON.stringify(responseBody, null, 2));

        return new Response(JSON.stringify(responseBody), {
            status: 200,
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
