const { Pool } = require('pg');

// Create the connection pool using variables from your .env file
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Test the connection immediately when the server starts
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.log("❌ DB CONNECTION FAILED: Check your .env file!");
        console.error("Error Message:", err.message);
    } else {
        console.log("✅ DB CONNECTED SUCCESSFULLY to PostgreSQL!");
    }
});

// Meaningful comment: Export the query function to be used in other files
module.exports = {
    query: (text, params) => pool.query(text, params),
};``