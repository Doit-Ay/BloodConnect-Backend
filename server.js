// server.js (Refactored for Supabase with Fix for Matching Logic)
require('dotenv').config();
const express = require("express");
const cors = require("cors");
const { createClient } = require('@supabase/supabase-js');

const app = express();

// --- Middleware ---
app.use(express.json());
app.use(cors());

// --- Constants ---
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("FATAL ERROR: Supabase URL or Service Key is missing in .env file.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
console.log("--> Supabase admin client initialized for server.");

// --- Helper Functions ---
const handleServerError = (res, error, message = "An internal server error occurred.") => {
  console.error("Server Error:", error);
  res.status(500).json({ error: message, details: error.message });
};

// --- Authentication Middleware ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Authentication token is required.' });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    req.user = user;
    next();
};

// --- Donor Matching Logic (Unchanged) ---
const urgencyWeights = { High: 0, Medium: 5, Low: 10 };
const locationPenalty = 5;
const compatibilityMap = { 'A+': ['A+', 'A-', 'O+', 'O-'], 'A-': ['A-', 'O-'], 'B+': ['B+', 'B-', 'O+', 'O-'], 'B-': ['B-', 'O-'], 'AB+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'], 'AB-': ['A-', 'B-', 'AB-', 'O-'], 'O+': ['O+', 'O-'], 'O-': ['O-'], };
const rules = [{ name: "High urgency: Top 10 donors", condition: req => req.urgency_level === "High", action: matches => matches.slice(0, 10) }, { name: "Medium urgency: Top 5 donors", condition: req => req.urgency_level === "Medium", action: matches => matches.slice(0, 5) }, { name: "Low urgency: Top 3 donors", condition: req => req.urgency_level === "Low", action: matches => matches.slice(0, 3) }];
const defaultRuleAction = matches => matches.slice(0, 5);
const defaultRuleName = "Default: Top 5 donors";

function scoreDonor(request, donor) {
    const uWeight = urgencyWeights[request.urgency_level] ?? 10;
    const locPenalty = donor.location?.toLowerCase() === request.location?.toLowerCase() ? 0 : locationPenalty;
    return uWeight + locPenalty;
}
function matchDonors(request, donors) {
    return donors.map(d => ({ ...d, score: scoreDonor(request, d) })).sort((a, b) => a.score - b.score);
}

// --- API Endpoints ---

// GET /blood_requests/:id/match
app.get("/blood_requests/:id/match", authenticateToken, async (req, res) => {
  const reqId = parseInt(req.params.id, 10);
  if (isNaN(reqId)) { return res.status(400).json({ error: "Invalid request ID." }); }

  try {
    const { data: request, error: requestError } = await supabase
        .from('blood_requests')
        .select('*')
        .eq('id', reqId)
        .single();

    if (requestError || !request) { return res.status(404).json({ error: "Blood request not found." }); }

    const compatibleDonorGroups = compatibilityMap[request.blood_group] || [];
    if (compatibleDonorGroups.length === 0) {
        return res.json({ request, ruleFired: "No compatibility rule", matches: [] });
    }

    const { data: donors, error: donorError } = await supabase
        .from('profiles')
        .select('id, name, phone, location, blood_group')
        .in('blood_group', compatibleDonorGroups)
        .neq('id', request.requester_id);

    if (donorError) { throw donorError; }

    // --- THE FIX IS HERE ---
    // If 'donors' is null (no donors found), use an empty array [] as a fallback.
    // This prevents the '.map()' function in matchDonors from crashing the server.
    const rankedDonors = matchDonors(request, donors || []);

    const rule = rules.find(r => r.condition(request));
    const finalMatches = rule ? rule.action(rankedDonors) : defaultRuleAction(rankedDonors);
    const ruleFired = rule ? rule.name : defaultRuleName;

    res.json({ request, ruleFired, matches: finalMatches });
  } catch (error) {
      handleServerError(res, error, "Failed to find donor matches.");
  }
});

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server running successfully on port ${PORT}.`);
});
