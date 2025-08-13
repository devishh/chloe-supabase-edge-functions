// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
};

Deno.serve(async (req) => {
    console.log("Function called with method:", req.method);
    
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        console.log("Handling CORS preflight");
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only handle GET requests
    if (req.method !== "GET") {
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

        // Use authed client for DB reads
        const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // Get today's date in UTC
        const today = new Date();
        const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        const todayEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));

        console.log("Searching for chat session between:", todayStart.toISOString(), "and", todayEnd.toISOString());

        // Get today's latest chat session with metadata
        const { data: chatSession, error: sessionErr } = await db
            .from("chat_session")
            .select(`
                id,
                title,
                title_updated_at,
                model,
                system_prompt_id,
                summarize_prompt_id,
                summary,
                summary_tokens,
                message_count,
                last_message_at,
                created_at,
                updated_at
            `)
            .eq("user_id", userId)
            .gte("created_at", todayStart.toISOString())
            .lt("created_at", todayEnd.toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        console.log("Chat session query result:", { 
            hasSession: !!chatSession, 
            sessionId: chatSession?.id, 
            error: sessionErr,
            created_at: chatSession?.created_at 
        });

        if (sessionErr) {
            console.log("Database query failed:", sessionErr);
            return new Response(JSON.stringify({ error: "Database query failed" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        if (!chatSession) {
            console.log("No chat session found for today");
            return new Response(JSON.stringify({ 
                chat_session_id: null,
                message: "No chat session found for today"
            }), {
                status: 404,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        // Get the latest message for additional context
        const { data: latestMessage, error: messageErr } = await db
            .from("chat_message")
            .select("id, role, content, created_at")
            .eq("session_id", chatSession.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        console.log("Latest message query result:", { 
            hasMessage: !!latestMessage, 
            messageId: latestMessage?.id, 
            error: messageErr 
        });

        const response = {
            chat_session_id: chatSession.id,
            title: chatSession.title,
            title_updated_at: chatSession.title_updated_at,
            model: chatSession.model,
            system_prompt_id: chatSession.system_prompt_id,
            summarize_prompt_id: chatSession.summarize_prompt_id,
            summary: chatSession.summary,
            summary_tokens: chatSession.summary_tokens,
            message_count: chatSession.message_count,
            last_message_at: chatSession.last_message_at,
            created_at: chatSession.created_at,
            updated_at: chatSession.updated_at,
            latest_message: latestMessage ? {
                id: latestMessage.id,
                role: latestMessage.role,
                content: latestMessage.content,
                created_at: latestMessage.created_at
            } : null
        };

        // Log the response payload before returning
        console.log("Response payload:", JSON.stringify(response, null, 2));

        return new Response(JSON.stringify(response), {
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
