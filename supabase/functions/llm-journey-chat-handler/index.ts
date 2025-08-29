// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";

// GROQ Configuration
const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_TEMPERATURE = 1.0;
const GROQ_MAX_TOKENS = 400;
const GROQ_TOP_P = 1.0;
const GROQ_REASONING_EFFORT = "medium";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

interface RequestBody {
    user_journey_id: string;
    role: "user";
    content: string;
}

interface ResponseBody {
    user_journey_id: string;
    user_journey_message_id: string;
    role: "assistant";
    content: string;
    ordinal: bigint;
    created_at: string;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });
    }

    try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const token = authHeader.replace("Bearer ", "");
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData?.user) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }
        const userId = userData.user.id;

        const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const requestBody: RequestBody = await req.json();
        if (!requestBody.user_journey_id || !requestBody.content) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const { user_journey_id, content } = requestBody;

        // Verify user journey belongs to user
        const { data: journeyData, error: journeyError } = await db
            .from("user_journey")
            .select("id, user_id, journey_key")
            .eq("id", user_journey_id)
            .single();

        if (journeyError || !journeyData || journeyData.user_id !== userId) {
            return new Response(JSON.stringify({ error: "Journey not found or access denied" }), {
                status: 404,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Save user message
        const { data: userMessageData, error: userMsgError } = await db
            .from("user_journey_message")
            .insert({
                user_journey_id: user_journey_id,
                user_id: userId,
                role: "user",
                content: content
            })
            .select("id, ordinal, created_at")
            .single();

        if (userMsgError || !userMessageData) {
            return new Response(JSON.stringify({ error: "Failed to save user message" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Get journey metadata for context
        const { data: journeyMeta, error: metaError } = await db
            .from("journeys")
            .select("title, description, theme, meta")
            .eq("key", journeyData.journey_key)
            .eq("is_active", true)
            .single();

        // Get journey-specific prompt
        const { data: promptData, error: promptError } = await db
            .from("prompts")
            .select("content")
            .eq("key", journeyData.journey_key)
            .eq("is_active", true)
            .single();

        if (!promptData?.content) {
            return new Response(JSON.stringify({ error: `Prompt not found for journey: ${journeyData.journey_key}` }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Use journey-specific prompt
        const systemPrompt = promptData.content;

        // Fetch last 40 messages from database
        const { data: dbMessages, error: messagesError } = await db
            .from("user_journey_message")
            .select("id, content, role, created_at")
            .eq("user_journey_id", user_journey_id)
            .order("created_at", { ascending: true })
            .limit(40);

        if (messagesError) {
            return new Response(JSON.stringify({ error: "Failed to fetch conversation history" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

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
        const groqRequest = {
            model: GROQ_MODEL,
            messages: groqMessages,
            temperature: GROQ_TEMPERATURE,
            max_completion_tokens: GROQ_MAX_TOKENS,
            top_p: GROQ_TOP_P,
            reasoning_effort: GROQ_REASONING_EFFORT,
            stream: false
        };
        
        console.log("GROQ Request JSON:", JSON.stringify(groqRequest, null, 2));
        
        const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(groqRequest)
        });

        if (!groqResponse.ok) {
            return new Response(JSON.stringify({ error: "GROQ API request failed" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const groqData = await groqResponse.json();
        console.log("GROQ Response JSON:", JSON.stringify(groqData, null, 2));
        
        const aiResponse = groqData.choices?.[0]?.message?.content?.trim();
        
        if (!aiResponse) {
            return new Response(JSON.stringify({ error: "GROQ returned empty response" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Save assistant response
        const { data: messageData, error: msgErr } = await db
            .from("user_journey_message")
            .insert({
                user_journey_id: user_journey_id,
                user_id: userId,
                role: "assistant",
                content: aiResponse
            })
            .select("id, ordinal, created_at")
            .single();

        if (msgErr || !messageData) {
            return new Response(JSON.stringify({ error: "Failed to save message" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Prepare response
        const responseBody: ResponseBody = {
            user_journey_id: user_journey_id,
            user_journey_message_id: messageData.id,
            role: "assistant",
            content: aiResponse,
            ordinal: messageData.ordinal,
            created_at: messageData.created_at
        };

        return new Response(JSON.stringify(responseBody), {
            status: 200,
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
