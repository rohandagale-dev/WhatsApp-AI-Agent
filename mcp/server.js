#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { PrismaClient } = require("@prisma/client");
const { google } = require("googleapis");
require("dotenv").config();

const prisma = new PrismaClient();

// Initialize Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground' // Must match the URI used to get the refresh token
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });
    console.error("[MCP] Google OAuth2 credentials initialized.");
} else {
    console.error("[MCP] WARNING: GOOGLE_REFRESH_TOKEN is missing. Private tools will fail.");
}

const server = new McpServer({
    name: "rohan-agent-server",
    version: "1.0.0",
});

// --- GOOGLE CALENDAR TOOL ---
server.tool(
    "get_calendar_events",
    "Fetch calendar events for a specific date to check for conflicts.",
    {
        date: z.string().describe("The date in DD/MM/YYYY format"),
    },
    async ({ date }) => {
        try {
            const apiKey = process.env.GOOGLE_API_KEY;
            if (!apiKey) {
                return { content: [{ type: "text", text: "Error: GOOGLE_API_KEY is not set in .env" }] };
            }

            // Convert DD/MM/YYYY to ISO
            const [day, month, year] = date.split("/");
            const timeMin = new Date(`${year}-${month}-${day}T00:00:00Z`).toISOString();
            const timeMax = new Date(`${year}-${month}-${day}T23:59:59Z`).toISOString();

            const calendar = google.calendar({ version: "v3", auth: oauth2Client });
            
            const response = await calendar.events.list({
                calendarId: "primary",
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: "startTime",
            });

            const events = response.data.items || [];
            if (events.length === 0) {
                return { content: [{ type: "text", text: `No commitments found for ${date}.` }] };
            }

            const eventList = events.map(e => {
                const start = e.start.dateTime || e.start.date;
                return `- ${e.summary} (${start})`;
            }).join("\n");

            return {
                content: [{ type: "text", text: `Commitments for ${date}:\n${eventList}` }],
            };
        } catch (error) {
            console.error("Calendar Tool Error:", error.message);
            return {
                content: [{ type: "text", text: `Failed to fetch calendar: ${error.message}. (Note: API Keys only work for public calendars; private calendars require OAuth2 tokens).` }],
            };
        }
    }
);

// --- GOOGLE TASKS TOOL ---
server.tool(
    "get_tasks",
    "List tasks from the user's todo list.",
    {
        listId: z.string().optional().describe("ID of the task list (defaults to @default)"),
    },
    async ({ listId = "@default" }) => {
        try {
            const tasks = google.tasks({ version: "v1", auth: oauth2Client });
            console.error(`[GOOGLE API] Calling Google Tasks API: GET https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`);
            const response = await tasks.tasks.list({
                tasklist: listId,
                showCompleted: false,
            });

            console.error(`[DEBUG] Google Tasks List Response Status: ${response.status}`);

            const items = response.data.items || [];
            if (items.length === 0) return { content: [{ type: "text", text: "No pending tasks found." }] };

            const taskList = items.map(t => `- [ ] ${t.title} ${t.due ? `(Due: ${new Date(t.due).toLocaleDateString()})` : ""}`).join("\n");
            return { content: [{ type: "text", text: `Your Tasks:\n${taskList}` }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Failed to fetch tasks: ${error.message}` }] };
        }
    }
);

server.tool(
    "add_task",
    "Add a new task to the todo list.",
    {
        title: z.string().describe("The task description"),
        due: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    },
    async ({ title, due }) => {
        try {
            const tasks = google.tasks({ version: "v1", auth: oauth2Client });
            console.error(`\n[GOOGLE API] Attempting to create task...`);
            console.error(`[GOOGLE API] URL: POST https://tasks.googleapis.com/tasks/v1/lists/@default/tasks`);
            
            const response = await tasks.tasks.insert({
                tasklist: "@default",
                requestBody: {
                    title,
                    due: due ? new Date(due).toISOString() : undefined,
                },
            });

            console.error(`[GOOGLE API] Status: ${response.status}`);
            console.error(`[GOOGLE API] Data:`, JSON.stringify(response.data, null, 2));

            return { content: [{ type: "text", text: `Task added: ${response.data.title}` }] };
        } catch (error) {
            console.error(`\n[GOOGLE API ERROR] Failed to add task!`);
            console.error(`[GOOGLE API ERROR] Message: ${error.message}`);
            if (error.message.includes("API key")) {
                console.error(`[GOOGLE API ERROR] IMPORTANT: Google Tasks API requires OAuth2 for creating tasks. An API key is not enough.`);
            }
            return { content: [{ type: "text", text: `Failed to add task: ${error.message}` }] };
        }
    }
);

// --- PRISMA INSIGHT TOOL ---
server.tool(
    "record_insight",
    "Save a new insight or preference learned about a contact from the conversation.",
    {
        phoneNumber: z.string().describe("The contact's phone number"),
        about: z.string().describe("Category: location / mood / habit / preference / plan"),
        value: z.string().describe("The detail learned (e.g., 'Likes black coffee')"),
    },
    async ({ phoneNumber, about, value }) => {
        try {
            const contact = await prisma.contact.findUnique({
                where: { phone: phoneNumber }
            });

            if (!contact) {
                return { content: [{ type: "text", text: `Contact ${phoneNumber} not found.` }] };
            }

            const summary = `[${about.toUpperCase()}] ${value}`;
            await prisma.insight.create({
                data: {
                    contactId: contact.id,
                    summary: summary,
                    messageCount: 0 // Identifier for system-recorded insight
                }
            });

            return {
                content: [{ type: "text", text: `Insight recorded for ${phoneNumber}: ${summary}` }],
            };
        } catch (error) {
            return { content: [{ type: "text", text: `Failed to record insight: ${error.message}` }] };
        }
    }
);

// --- WHATSAPP HISTORY TOOL ---
server.tool(
    "get_chat_history",
    "Fetch the last 10 messages for a contact to understand context better.",
    {
        phoneNumber: z.string().describe("The contact's phone number"),
    },
    async ({ phoneNumber }) => {
        try {
            const contact = await prisma.contact.findUnique({
                where: { phone: phoneNumber },
                include: { chats: { orderBy: { createdAt: 'desc' }, take: 10 } }
            });

            if (!contact) return { content: [{ type: "text", text: "Contact not found." }] };

            const history = contact.chats.reverse().map(m => `${m.direction}: ${m.message}`).join("\n");
            return { content: [{ type: "text", text: history || "No message history." }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }] };
        }
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Rohan Agent MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
