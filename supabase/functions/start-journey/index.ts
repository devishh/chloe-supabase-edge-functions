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
    user_journey_id: string;
}

interface ResponseBody {
    user_journey_id: string;
    user_journey_message_id: string;
    content: string;
    role: "assistant";
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
        if (!requestBody.user_journey_id) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const { user_journey_id } = requestBody;

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

        // Get user's preferred name
        let preferredName: string | null = null;
        try {
            const { data: profile, error: profileError } = await db
                .from("profiles")
                .select("preferred_name")
                .eq("id", userId)
                .maybeSingle();
            preferredName = profile?.preferred_name ?? null;
        } catch (error) { 
            // Continue without preferred name
        }

        // Get journey metadata
        const { data: journeyMeta, error: metaError } = await db
            .from("journeys")
            .select("title, description, theme")
            .eq("key", journeyData.journey_key)
            .eq("is_active", true)
            .single();

        // Get journey-specific and user-specific prompts
        const { data: promptsData, error: promptsError } = await db
            .from("prompts")
            .select("key, content")
            .in("key", [journeyData.journey_key, `${journeyData.journey_key}_user`])
            .eq("is_active", true);

        if (promptsError || !promptsData || promptsData.length === 0) {
            return new Response(JSON.stringify({ error: `Prompts not found for journey: ${journeyData.journey_key}` }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Find the journey prompt and user prompt
        const journeyPrompt = promptsData.find(p => p.key === journeyData.journey_key);
        const userPrompt = promptsData.find(p => p.key === `${journeyData.journey_key}_user`);

        if (!journeyPrompt?.content) {
            return new Response(JSON.stringify({ error: `Journey prompt not found for: ${journeyData.journey_key}` }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Send to GROQ
        const groqRequest = {
            model: GROQ_MODEL,
            messages: [
                {
                    role: "system",
                    content: journeyPrompt.content
                },
                {
                    role: "user",
                    content: userPrompt?.content
                }
            ],
            temperature: GROQ_TEMPERATURE,
            max_completion_tokens: GROQ_MAX_TOKENS,
            top_p: GROQ_TOP_P,
            reasoning_effort: GROQ_REASONING_EFFORT,
            stream: false
        };
        
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
        const aiResponse = groqData.choices?.[0]?.message?.content?.trim();
        
        if (!aiResponse) {
            return new Response(JSON.stringify({ error: "GROQ returned empty response" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Insert assistant message
        const { data: insertedMessage, error: msgErr } = await db
            .from("user_journey_message")
            .insert({
                user_journey_id: user_journey_id,
                user_id: userId,
                role: "assistant",
                content: aiResponse
            })
            .select("id, ordinal, created_at")
            .single();

        if (msgErr || !insertedMessage) {
            return new Response(JSON.stringify({ error: "Failed to write message" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const payload: ResponseBody = {
            user_journey_id: user_journey_id,
            user_journey_message_id: insertedMessage.id,
            content: aiResponse,
            role: "assistant",
            ordinal: insertedMessage.ordinal as bigint,
            created_at: insertedMessage.created_at
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
