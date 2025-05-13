// server.js (FreeSQLDatabase Primary with Local Fallback)

// Load environment variables from .env file
require('dotenv').config(); // Make sure this is at the very top

const express = require("express");
const mysql = require("mysql2/promise"); // Use the promise-based wrapper
const cors = require("cors");
const bcrypt = require("bcrypt"); // For password hashing

const app = express();

// --- Middleware ---
app.use(express.json()); // Parse JSON request bodies
app.use(cors()); // Enable Cross-Origin Resource Sharing

// --- Constants ---
const saltRounds = 10; // Cost factor for bcrypt hashing
const PORT = process.env.PORT || 3000;

// --- Database Configurations ---
const freeSqlDbConfig = {
  host: process.env.DB_HOST_FREESQL,
  user: process.env.DB_USER_FREESQL,
  password: process.env.DB_PASSWORD_FREESQL,
  database: process.env.DB_NAME_FREESQL,
  port: process.env.DB_PORT_FREESQL || 3306,
  waitForConnections: true,
  connectionLimit: 10, // Free tier might have lower limits, adjust if needed
  queueLimit: 0,
  connectTimeout: 20000 // Longer timeout for remote free DBs
};

const localDbConfig = {
  host: process.env.DB_HOST_LOCAL,
  user: process.env.DB_USER_LOCAL,
  password: process.env.DB_PASSWORD_LOCAL,
  database: process.env.DB_NAME_LOCAL,
  port: process.env.DB_PORT_LOCAL || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000
};

// --- Database Connection Pool (Attempt FreeSQLDatabase, then Local) ---
let pool; // This will hold the active pool
let activeDbConfig = null; // To track which config is used

console.log("Attempting to connect to FreeSQLDatabase (Primary)...");
try {
    // Validate essential FreeSQLDatabase config
    if (!freeSqlDbConfig.host || !freeSqlDbConfig.user || !freeSqlDbConfig.password || !freeSqlDbConfig.database) {
        console.warn("WARN: Missing required FreeSQLDatabase configuration in .env. Skipping FreeSQLDatabase connection attempt.");
        throw new Error("Incomplete FreeSQLDatabase config");
    }
    pool = mysql.createPool(freeSqlDbConfig);
    activeDbConfig = freeSqlDbConfig;
    console.log("--> PRIMARY FreeSQLDatabase Connection Pool Created for:", freeSqlDbConfig.host);
} catch (freeSqlError) {
    console.warn(`WARN: Could not create pool for FreeSQLDatabase (${freeSqlDbConfig.host}): ${freeSqlError.message}`);
    console.log("Attempting to connect to Local MySQL Database as fallback...");
    pool = null; // Ensure pool is null if primary failed

    try {
        // Validate essential Local DB config
        if (!localDbConfig.host || !localDbConfig.user || !localDbConfig.database) {
            console.error("FATAL ERROR: Missing required Local MySQL database configuration for fallback. Cannot start server.");
            process.exit(1);
        }
        pool = mysql.createPool(localDbConfig);
        activeDbConfig = localDbConfig;
        console.log("--> FALLBACK Local MySQL Connection Pool Created for:", localDbConfig.host);
    } catch (localErrorFallback) {
        console.error(`FATAL ERROR: Failed to create pool for Local MySQL DB as fallback (${localDbConfig.host}): ${localErrorFallback.message}`);
        process.exit(1); // Exit if both primary and fallback fail
    }
}

// --- Test Active Connection ---
if (pool && activeDbConfig) {
    pool.getConnection()
        .then(connection => {
            console.log(`Successfully connected to the ACTIVE database (${activeDbConfig.host}) via pool.`);
            connection.release();
        })
        .catch(err => {
            console.error(`Initial connection test failed for ACTIVE database (${activeDbConfig.host}):`, err.message);
             if (activeDbConfig === freeSqlDbConfig) {
                 if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                     console.error("Hint: Check if the FreeSQLDatabase DB_HOST_FREESQL and DB_PORT_FREESQL are correct and if the database instance is active.");
                 } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
                      console.error("Hint: Check if FreeSQLDatabase DB_USER_FREESQL and DB_PASSWORD_FREESQL are correct.");
                 } else if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
                      console.error("Hint: FreeSQLDatabase might be slow or your network might have issues reaching it. Also, check if your IP is whitelisted if the service requires it.");
                 }
             } else if (activeDbConfig === localDbConfig) {
                 if (err.code === 'ECONNREFUSED') {
                     console.error("Hint: Check if your local MySQL server is running.");
                 } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
                     console.error("Hint: Check if local DB_USER_LOCAL and DB_PASSWORD_LOCAL are correct.");
                 }
             }
            // Consider exiting if the chosen DB connection fails the initial test
            // process.exit(1);
        });
} else {
    console.error("FATAL ERROR: No database connection pool could be established.");
    process.exit(1);
}


// --- Authentication Middleware (Placeholder) ---
const authenticateToken = (req, res, next) => {
  // console.log("Auth Middleware Placeholder: No actual authentication implemented.");
  next();
};


// --- Helper Function for Error Handling ---
const handleServerError = (res, error, message = "An internal server error occurred.") => {
    console.error("Server Error:", error); // Log the actual error
    res.status(500).json({ error: message });
};

// --- API Endpoints ---
// (These endpoints remain the same, they will use the 'pool' variable
// which points to either the FreeSQLDatabase or Local MySQL pool)

// --- USERS ENDPOINTS ---
app.post("/users", async (req, res) => {
  const { name, dob, gender, phone, bloodGroup, location, email, password } = req.body;
  if (!email || !password || !name ) { return res.status(400).json({ error: "Missing required fields for signup." }); }
  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const sql = `INSERT INTO users (name, dob, gender, phone, bloodGroup, location, email, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [ name, dob || null, gender || null, phone || null, bloodGroup || null, location || null, email.toLowerCase(), hashedPassword ];
    const [results] = await pool.query(sql, params);
    res.status(201).json({ message: "User created successfully", userId: results.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') { return res.status(409).json({ error: "Email address already in use." }); }
    handleServerError(res, error, "Failed to create user.");
  }
});

app.post("/users/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) { return res.status(400).json({ error: "Email and password are required." }); }
  try {
    const sql = "SELECT id, email, password, name FROM users WHERE email = ?";
    const [results] = await pool.query(sql, [email.toLowerCase()]);
    if (results.length === 0) { return res.status(401).json({ error: "Invalid email or password." }); }
    const user = results[0];
    const match = await bcrypt.compare(password, user.password);
    if (match) {
      const userData = { userId: user.id, email: user.email, name: user.name };
      res.json(userData);
    } else {
      res.status(401).json({ error: "Invalid email or password." });
    }
  } catch (error) {
    handleServerError(res, error, "Login failed due to a server error.");
  }
});

app.get("/users/:id", /* authenticateToken, */ async (req, res) => {
    const userId = req.params.id;
    try {
        const sql = "SELECT id, name, dob, gender, phone, bloodGroup, location, email, createdAt FROM users WHERE id = ?";
        const [results] = await pool.query(sql, [userId]);
        if (results.length === 0) { return res.status(404).json({ error: "User not found." }); }
        res.json(results[0]);
    } catch (error) {
        handleServerError(res, error, "Failed to retrieve user profile.");
    }
});

app.put("/users/:id", authenticateToken, async (req, res) => {
    const userIdToUpdate = req.params.id;
    const { name, dob, gender, phone, bloodGroup, location } = req.body;
    if (!name || !dob || !gender || !phone || !bloodGroup || !location) { return res.status(400).json({ error: "Missing required profile fields." }); }
    try {
        const sql = `UPDATE users SET name=?, dob=?, gender=?, phone=?, bloodGroup=?, location=? WHERE id=?`;
        const params = [ name, dob || null, gender || null, phone || null, bloodGroup || null, location || null, userIdToUpdate ];
        const [results] = await pool.query(sql, params);
        if (results.affectedRows === 0) { return res.status(404).json({ error: "User not found or no changes made." }); }
        const [updatedUser] = await pool.query("SELECT id, name, dob, gender, phone, bloodGroup, location, email FROM users WHERE id = ?", [userIdToUpdate]);
        res.json(updatedUser[0]);
    } catch (error) {
        handleServerError(res, error, "Failed to update profile.");
    }
});

// --- BLOOD REQUESTS ENDPOINTS ---
app.post("/blood_requests", /* authenticateToken, */ async (req, res) => {
  const { requesterId, name, bloodGroup, location, address, phone, note, urgencyLevel } = req.body;
  if (!requesterId || !name || !bloodGroup || !location || !address || !phone || !urgencyLevel) { return res.status(400).json({ error: "Missing required fields for blood request." }); }
  try {
    const sql = `INSERT INTO blood_requests (requesterId, name, bloodGroup, location, address, phone, note, urgencyLevel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [ requesterId, name, bloodGroup, location, address, phone, note || null, urgencyLevel ];
    const [results] = await pool.query(sql, params);
    res.status(201).json({ message: "Blood request created", id: results.insertId });
  } catch (error) {
    handleServerError(res, error, "Failed to create blood request.");
  }
});

app.get("/blood_requests", async (req, res) => {
  let sql = "SELECT * FROM blood_requests"; const params = []; const conditions = [];
  const { bloodGroup, location, status = 'Pending' } = req.query;
  if (status && ['Pending', 'Fulfilled', 'Cancelled'].includes(status)) { conditions.push("requestStatus = ?"); params.push(status); }
  else if (status) { return res.status(400).json({ error: "Invalid status filter value." }); }
  else { conditions.push("requestStatus = 'Pending'"); }
  if (bloodGroup) { conditions.push("bloodGroup = ?"); params.push(bloodGroup); }
  if (location) { conditions.push("location = ?"); params.push(location); }
  if (conditions.length > 0) { sql += " WHERE " + conditions.join(" AND "); }
  sql += " ORDER BY createdAt DESC";
  try {
    const [results] = await pool.query(sql, params);
    res.json(results);
  } catch (error) {
    handleServerError(res, error, "Failed to retrieve blood requests.");
  }
});

// --- MATCHING ENDPOINT ---
const urgencyWeights = { High: 0, Medium: 5, Low: 10 }; const locationPenalty = 5;
const compatibilityMap = { 'A+': ['A+', 'A-', 'O+', 'O-'], 'A-': ['A-', 'O-'], 'B+': ['B+', 'B-', 'O+', 'O-'], 'B-': ['B-', 'O-'], 'AB+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'], 'AB-': ['A-', 'B-', 'AB-', 'O-'], 'O+': ['O+', 'O-'], 'O-': ['O-'], };
const rules = [ { name: "High urgency: Top 10 donors", condition: req => req.urgencyLevel === "High", action: matches => matches.slice(0, 10) }, { name: "Medium urgency: Top 5 donors", condition: req => req.urgencyLevel === "Medium", action: matches => matches.slice(0, 5) }, { name: "Low urgency: Top 3 donors", condition: req => req.urgencyLevel === "Low", action: matches => matches.slice(0, 3) }, ];
const defaultRuleAction = matches => matches.slice(0, 5); const defaultRuleName = "Default: Top 5 donors";
function scoreDonor(request, donor) { const uWeight = urgencyWeights[request.urgencyLevel] ?? 10; const locPenalty = donor.location?.toLowerCase() === request.location?.toLowerCase() ? 0 : locationPenalty; return uWeight + locPenalty; }
function matchDonors(request, donors) { return donors.map(d => ({ ...d, score: scoreDonor(request, d) })).sort((a, b) => a.score - b.score); }

app.get("/blood_requests/:id/match", async (req, res) => {
  const reqId = parseInt(req.params.id, 10);
  if (isNaN(reqId)) { return res.status(400).json({ error: "Invalid request ID." }); }
  try {
    const [reqRows] = await pool.query("SELECT * FROM blood_requests WHERE id = ?", [reqId]);
    if (reqRows.length === 0) { return res.status(404).json({ error: "Blood request not found." }); }
    const request = reqRows[0];
    const compatibleDonorGroups = compatibilityMap[request.bloodGroup] || [];
    if (compatibleDonorGroups.length === 0) { return res.json({ request, ruleFired: "No compatibility rule", matches: [] }); }
    const donorSql = `SELECT id, name, phone, location, bloodGroup FROM users WHERE bloodGroup IN (?) AND id != ?`;
    const [donors] = await pool.query(donorSql, [compatibleDonorGroups, request.requesterId]);
    const rankedDonors = matchDonors(request, donors);
    const rule = rules.find(r => r.condition(request));
    const finalMatches = rule ? rule.action(rankedDonors) : defaultRuleAction(rankedDonors);
    const ruleFired = rule ? rule.name : defaultRuleName;
    res.json({ request, ruleFired, matches: finalMatches });
  } catch (error) { handleServerError(res, error, "Failed to find donor matches."); }
});

// --- CAMPS ENDPOINTS ---
app.post("/camps", authenticateToken, async (req, res) => {
  const { title, description, location, address, date, imageUrl } = req.body;
  const creatorId = 1; // Placeholder
  if (!title || !location || !address || !date ) { return res.status(400).json({ error: "Missing required fields." }); }
  try {
    const sql = `INSERT INTO camps (title, description, location, address, date, imageUrl, creatorId) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    const params = [ title, description || null, location, address, date, imageUrl || null, creatorId ];
    const [results] = await pool.query(sql, params);
    res.status(201).json({ message: "Camp created successfully", id: results.insertId });
  } catch (error) { handleServerError(res, error, "Failed to create camp."); }
});

app.get("/camps", async (req, res) => {
    const { location } = req.query;
    let sql = "SELECT * FROM camps"; const params = [];
    if (location && location !== 'All Locations') { sql += " WHERE location = ?"; params.push(location); }
    sql += " ORDER BY date DESC";
    try { const [results] = await pool.query(sql, params); res.json(results); }
    catch (error) { handleServerError(res, error, "Failed to retrieve camps."); }
});

app.put("/camps/:id", authenticateToken, async (req, res) => {
    const campId = req.params.id; const loggedInUserId = 1; // Placeholder
    const { title, description, location, address, date, imageUrl } = req.body;
    if (!title || !location || !address || !date) { return res.status(400).json({ error: "Missing required fields." }); }
    try {
        const [campResult] = await pool.query("SELECT creatorId FROM camps WHERE id = ?", [campId]);
        if (campResult.length === 0) { return res.status(404).json({ error: "Camp not found." }); }
        // Add real authorization check here if needed
        const sql = `UPDATE camps SET title=?, description=?, location=?, address=?, date=?, imageUrl=? WHERE id=?`;
        const params = [ title, description || null, location, address, date, imageUrl || null, campId ];
        const [results] = await pool.query(sql, params);
        if (results.affectedRows === 0) { return res.status(404).json({ error: "Camp not found or no changes applied." }); }
        res.json({ message: "Camp updated successfully" });
    } catch (error) { handleServerError(res, error, "Failed to update camp."); }
});

app.delete("/camps/:id", authenticateToken, async (req, res) => {
    const campId = req.params.id; const loggedInUserId = 1; // Placeholder
    try {
        const [campResult] = await pool.query("SELECT creatorId FROM camps WHERE id = ?", [campId]);
        if (campResult.length === 0) { return res.status(404).json({ error: "Camp not found." }); }
        // Add real authorization check here if needed
        const sql = "DELETE FROM camps WHERE id = ?";
        const params = [campId];
        const [results] = await pool.query(sql, params);
        if (results.affectedRows > 0) { res.json({ message: "Camp deleted successfully" }); }
        else { res.status(404).json({ error: "Camp not found or already deleted." }); }
    } catch (err) { handleServerError(res, err, "Failed to delete camp."); }
});


// --- Root Endpoint ---
app.get("/", (req, res) => {
  res.send(`Blood Donation API is running on port ${PORT}! Connected to: ${activeDbConfig?.host || 'UNKNOWN DB'}`);
});

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server running successfully on port ${PORT}.`);
  if(activeDbConfig) {
      console.log(`--> Connected to database: ${activeDbConfig.host} (${activeDbConfig === localDbConfig ? 'LOCAL (Fallback)' : 'FreeSQLDatabase (Primary)'})`);
  } else {
      console.error("--> SEVERE: Server started but NO database connection is active!");
  }
});

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => {
    console.log(`${signal} signal received: closing MySQL pool for ${activeDbConfig?.host || 'N/A'}`);
    if (pool) { // Check if pool was successfully created
        try {
            await pool.end();
            console.log('MySQL pool closed');
            process.exit(0);
        } catch (err) {
            console.error('Error closing MySQL pool:', err);
            process.exit(1);
        }
    } else {
        console.log('No active pool to close.');
        process.exit(0);
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
