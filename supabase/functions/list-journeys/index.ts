// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

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

        // Use authed client for DB reads
        const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: journeys, error: journeysErr } = await db
            .from("journeys")
            .select("id, key, title, short_description, theme, meta, order")
            .eq("is_active", true)
            .order("order", { ascending: true });

        if (journeysErr) {
            return new Response(JSON.stringify({ error: "Database query failed" }), {
                status: 500,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        return new Response(JSON.stringify({ 
            journeys: journeys || [], 
            count: journeys?.length || 0 
        }), {
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
