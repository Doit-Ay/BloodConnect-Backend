// server.js (Refactored for Supabase)

// Load environment variables from .env file
require('dotenv').config();

const express = require("express");
const cors = "cors";
const { createClient } = require('@supabase/supabase-js'); // Import the Supabase client

const app = express();

// --- Middleware ---
app.use(express.json()); // Parse JSON request bodies
app.use(cors()); // Enable Cross-Origin Resource Sharing

// --- Constants ---
const PORT = process.env.PORT || 3000;

// --- Supabase Configuration & Initialization ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Validate that Supabase credentials are provided
if (!supabaseUrl || !supabaseKey) {
    console.error("FATAL ERROR: Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env file.");
    process.exit(1);
}

// Create a single Supabase client for interacting with your database
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("--> Supabase client initialized.");

// --- Helper Function for Error Handling ---
const handleSupabaseError = (res, error, message = "An internal server error occurred.") => {
    console.error("Supabase Error:", error);
    // Use the error message from Supabase if available, otherwise use the generic one.
    res.status(error.status || 500).json({ error: error.message || message });
};


// --- Authentication Middleware (The Supabase Way) ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Expecting "Bearer <TOKEN>"

    if (!token) {
        return res.status(401).json({ error: 'Authentication token is required.' });
    }

    // Ask Supabase to verify the token
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
        // This handles expired tokens, invalid tokens, etc.
        return res.status(401).json({ error: 'Invalid or expired token.', details: error.message });
    }
    if (!user) {
         return res.status(401).json({ error: 'Authentication failed. User not found.' });
    }
    // Attach the authenticated user to the request object for use in other routes
    req.user = user;
    next();
};


// --- API Endpoints (Refactored for Supabase) ---

// --- USERS / AUTH ENDPOINTS ---

// POST /auth/signup - Handles user registration
app.post("/auth/signup", async (req, res) => {
    const { name, dob, gender, phone, bloodGroup, location, email, password } = req.body;

    if (!email || !password || !name) {
        return res.status(400).json({ error: "Name, email, and password are required for signup." });
    }

    // Step 1: Create the user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
        email: email.toLowerCase(),
        password: password,
    });

    if (authError) {
        return handleSupabaseError(res, authError, "Failed to create user.");
    }
    if (!authData.user) {
        return res.status(500).json({ error: "User signup successful but no user data returned."})
    }


    // Step 2: Add the user's public profile info to the `profiles` table
    const { error: profileError } = await supabase
        .from('profiles')
        .insert({
            id: authData.user.id, // Link to the auth.users table
            name: name,
            dob: dob || null,
            gender: gender || null,
            phone: phone || null,
            blood_group: bloodGroup || null,
            location: location || null,
            email: email.toLowerCase() // You can store email here for easier queries
        });

    if (profileError) {
        // Important: If profile creation fails, you might want to delete the auth user
        // to avoid orphaned auth entries. This is an advanced topic (e.g., use a Postgres function).
        // For now, we'll just log the error.
        console.error("CRITICAL: Auth user was created but profile insertion failed:", profileError);
        return handleSupabaseError(res, profileError, "User was created but failed to save profile details.");
    }

    res.status(201).json({ message: "User created successfully. Please check your email for verification.", userId: authData.user.id });
});

// POST /auth/login - Handles user login
app.post("/auth/login", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
        email: email.toLowerCase(),
        password: password,
    });

    if (error) {
        return handleSupabaseError(res, error, "Invalid email or password.");
    }

    // On success, 'data' contains the session (with access_token) and user info
    res.json(data);
});


// GET /profiles/:id - Get a user's public profile
// NOTE: Now using the authenticateToken middleware
app.get("/profiles/:id", authenticateToken, async (req, res) => {
    const userId = req.params.id;

    const { data, error } = await supabase
        .from('profiles')
        .select(`id, name, dob, gender, phone, blood_group, location, email, created_at`)
        .eq('id', userId)
        .single(); // .single() returns one object instead of an array

    if (error) {
        return handleSupabaseError(res, error, "Failed to retrieve user profile.");
    }
    if (!data) {
        return res.status(404).json({ error: "User not found." });
    }

    res.json(data);
});

// PUT /profiles/me - Update the logged-in user's profile
// It's better practice to have an endpoint like `/me` for the logged-in user
app.put("/profiles/me", authenticateToken, async (req, res) => {
    // The user's ID comes from the validated token, not the URL params. This is more secure.
    const userIdToUpdate = req.user.id;
    const { name, dob, gender, phone, bloodGroup, location } = req.body;

    if (!name || !dob || !gender || !phone || !bloodGroup || !location) {
        return res.status(400).json({ error: "Missing required profile fields." });
    }

    const { data, error } = await supabase
        .from('profiles')
        .update({
            name: name,
            dob: dob || null,
            gender: gender || null,
            phone: phone || null,
            blood_group: bloodGroup || null,
            location: location || null
        })
        .eq('id', userIdToUpdate)
        .select(); // .select() returns the updated record

    if (error) {
        return handleSupabaseError(res, error, "Failed to update profile.");
    }

    res.json(data[0]);
});


// --- BLOOD REQUESTS ENDPOINTS ---
app.post("/blood_requests", authenticateToken, async (req, res) => {
    const { name, bloodGroup, location, phone, urgencyLevel } = req.body;
    // The requester's ID comes from the authenticated user
    const requesterId = req.user.id;

    if (!name || !bloodGroup || !location || !phone || !urgencyLevel) {
        return res.status(400).json({ error: "Missing required fields for blood request." });
    }

    const { data, error } = await supabase
        .from('blood_requests')
        .insert({
            requester_id: requesterId,
            // name: name, // Name can be fetched from the profiles table based on requesterId
            blood_group: bloodGroup,
            location: location,
            phone: phone,
            urgency_level: urgencyLevel
        })
        .select()
        .single();

    if (error) {
        return handleSupabaseError(res, error, "Failed to create blood request.");
    }

    res.status(201).json({ message: "Blood request created", request: data });
});

app.get("/blood_requests", async (req, res) => {
    const { bloodGroup, location, status = 'Pending' } = req.query;

    let query = supabase.from('blood_requests').select('*');

    // Apply filters
    if (status && ['Pending', 'Completed', 'Cancelled'].includes(status)) {
        query = query.eq('request_status', status);
    } else {
        query = query.eq('request_status', 'Pending'); // Default filter
    }
    if (bloodGroup) {
        query = query.eq('blood_group', bloodGroup);
    }
    if (location) {
        query = query.eq('location', location);
    }

    // Order the results
    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
        return handleSupabaseError(res, error, "Failed to retrieve blood requests.");
    }

    res.json(data);
});

// --- MATCHING ENDPOINT (Logic is the same, queries are updated) ---
// (Your complex matching logic remains unchanged, only the data fetching part is modified)
const urgencyWeights = { High: 0, Medium: 5, Low: 10 };
const locationPenalty = 5;
const compatibilityMap = { 'A+': ['A+', 'A-', 'O+', 'O-'], 'A-': ['A-', 'O-'], 'B+': ['B+', 'B-', 'O+', 'O-'], 'B-': ['B-', 'O-'], 'AB+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'], 'AB-': ['A-', 'B-', 'AB-', 'O-'], 'O+': ['O+', 'O-'], 'O-': ['O-'] };
const rules = [{ name: "High urgency: Top 10 donors", condition: req => req.urgency_level === "High", action: matches => matches.slice(0, 10) }, { name: "Medium urgency: Top 5 donors", condition: req => req.urgency_level === "Medium", action: matches => matches.slice(0, 5) }, { name: "Low urgency: Top 3 donors", condition: req => req.urgency_level === "Low", action: matches => matches.slice(0, 3) }];
const defaultRuleAction = matches => matches.slice(0, 5); const defaultRuleName = "Default: Top 5 donors";
function scoreDonor(request, donor) { const uWeight = urgencyWeights[request.urgency_level] ?? 10; const locPenalty = donor.location?.toLowerCase() === request.location?.toLowerCase() ? 0 : locationPenalty; return uWeight + locPenalty; }
function matchDonors(request, donors) { return donors.map(d => ({ ...d, score: scoreDonor(request, d) })).sort((a, b) => a.score - b.score); }


app.get("/blood_requests/:id/match", authenticateToken, async (req, res) => {
    const reqId = parseInt(req.params.id, 10);
    if (isNaN(reqId)) { return res.status(400).json({ error: "Invalid request ID." }); }

    try {
        // Step 1: Get the blood request details
        const { data: request, error: requestError } = await supabase
            .from('blood_requests')
            .select('*')
            .eq('id', reqId)
            .single();

        if (requestError || !request) {
            return res.status(404).json({ error: "Blood request not found." });
        }

        const compatibleDonorGroups = compatibilityMap[request.blood_group] || [];
        if (compatibleDonorGroups.length === 0) {
            return res.json({ request, ruleFired: "No compatibility rule", matches: [] });
        }

        // Step 2: Get all compatible donors from the 'profiles' table
        const { data: donors, error: donorError } = await supabase
            .from('profiles')
            .select('id, name, phone, location, blood_group')
            .in('blood_group', compatibleDonorGroups)
            .neq('id', request.requester_id); // Don't match the requester with themselves

        if (donorError) {
             return handleSupabaseError(res, donorError, "Failed to search for donors.");
        }

        // --- Your existing matching logic (no changes needed here) ---
        const rankedDonors = matchDonors(request, donors);
        const rule = rules.find(r => r.condition(request));
        const finalMatches = rule ? rule.action(rankedDonors) : defaultRuleAction(rankedDonors);
        const ruleFired = rule ? rule.name : defaultRuleName;

        res.json({ request, ruleFired, matches: finalMatches });
    } catch (error) {
        // This is for unexpected JavaScript errors in the matching logic itself
        console.error("Matching Logic Error:", error);
        res.status(500).json({ error: "A server error occurred while matching donors." });
    }
});


// --- CAMPS ENDPOINTS ---
app.post("/camps", authenticateToken, async (req, res) => {
    const { title, description, location, date, imageUrl } = req.body;
    const creatorId = req.user.id; // Get creator ID from the authenticated user

    if (!title || !location || !date) {
        return res.status(400).json({ error: "Title, location, and date are required." });
    }

    const { data, error } = await supabase
        .from('camps')
        .insert({ title, description, location, date, image_url: imageUrl, creator_id: creatorId })
        .select()
        .single();

    if (error) {
        return handleSupabaseError(res, error, "Failed to create camp.");
    }

    res.status(201).json({ message: "Camp created successfully", camp: data });
});

// GET /camps - No authentication needed to view camps
app.get("/camps", async (req, res) => {
    const { location } = req.query;
    let query = supabase.from('camps').select('*');

    if (location && location !== 'All Locations') {
        query = query.eq('location', location);
    }
    query = query.order('date', { ascending: false });

    const { data, error } = await query;

    if (error) {
        return handleSupabaseError(res, error, "Failed to retrieve camps.");
    }
    res.json(data);
});


// --- Root Endpoint ---
app.get("/", (req, res) => {
    res.send(`Blood Donation API (Supabase) is running on port ${PORT}!`);
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Server running successfully on port ${PORT}.`);
    console.log(`Connected to Supabase project at: ${supabaseUrl.split('.')[0]}.supabase.co`);
});
