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

interface RequestBody {
    chat_session_id: string;
    role: "user";
    content: string;
}

interface ResponseBody {
    chat_session_id: string;
    chat_message_id: string;
    role: "assistant";
    content: string;
    ordinal: bigint;
    created_at: string;
}

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
        console.log("Request body:", { 
            chat_session_id: requestBody.chat_session_id, 
            content_length: requestBody.content?.length 
        });

        if (!requestBody.chat_session_id || !requestBody.content) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const { chat_session_id, content } = requestBody;

        // Verify chat session belongs to user
        console.log("Verifying chat session ownership...");
        const { data: sessionData, error: sessionError } = await db
            .from("chat_session")
            .select("id, user_id")
            .eq("id", chat_session_id)
            .single();

        if (sessionError || !sessionData || sessionData.user_id !== userId) {
            console.log("Session verification failed:", sessionError);
            return new Response(JSON.stringify({ error: "Chat session not found or access denied" }), {
                status: 404,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        console.log("Chat session verified, ID:", chat_session_id);

        // Save user message first and get back generated values
        console.log("Saving user message...");
        const { data: userMessageData, error: userMsgError } = await db
            .from("chat_message")
            .insert({
                session_id: chat_session_id,
                user_id: userId,
                role: "user",
                content: content
            })
            .select("id, ordinal, created_at")
            .single();

        if (userMsgError || !userMessageData) {
            console.log("Failed to save user message:", userMsgError);
            return new Response(JSON.stringify({ error: "Failed to save user message" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        console.log("User message saved:", { 
            messageId: userMessageData.id, 
            ordinal: userMessageData.ordinal,
            createdAt: userMessageData.created_at 
        });

        // Get system prompt
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

        const systemPrompt = promptData.content;

        // Fetch last 40 messages (20 pairs) from database
        console.log("Fetching last 40 messages from database...");
        const { data: dbMessages, error: messagesError } = await db
            .from("chat_message")
            .select("id, content, role, created_at")
            .eq("session_id", chat_session_id)
            .order("created_at", { ascending: true })
            .limit(40);

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

        // Convert to GROQ format
        const groqMessages = [
            {
                role: "system",
                content: systemPrompt
            },
            ...(dbMessages || []).map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        ];

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
        
        const aiResponse = groqData.choices?.[0]?.message?.content?.trim();
        console.log("AI response extracted:", { hasResponse: !!aiResponse, responseLength: aiResponse?.length });
        
        if (!aiResponse) {
            console.log("GROQ returned empty response");
            return new Response(JSON.stringify({ error: "GROQ returned empty response" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Save assistant response to chat_message table and get back generated values
        console.log("Saving assistant message to database...");
        const { data: messageData, error: msgErr } = await db
            .from("chat_message")
            .insert({
                session_id: chat_session_id,
                user_id: userId,
                role: "assistant",
                content: aiResponse
            })
            .select("id, ordinal, created_at")
            .single();

        console.log("Message insertion result:", { 
            hasData: !!messageData, 
            messageId: messageData?.id, 
            ordinal: messageData?.ordinal,
            hasError: !!msgErr, 
            error: msgErr 
        });

        if (msgErr || !messageData) {
            console.log("Message insertion failed:", msgErr);
            return new Response(JSON.stringify({ error: "Failed to save message" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Prepare response
        const responseBody: ResponseBody = {
            chat_session_id: chat_session_id,
            chat_message_id: messageData.id,
            role: "assistant",
            content: aiResponse,
            ordinal: messageData.ordinal,
            created_at: messageData.created_at
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
