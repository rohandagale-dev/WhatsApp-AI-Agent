const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require("path");

class McpClient {
    constructor() {
        this.client = new Client({
            name: "whatsapp-bot-client",
            version: "1.0.0",
        }, {
            capabilities: {}
        });
    }

    async connect() {
        const transport = new StdioClientTransport({
            command: "node",
            args: [path.join(__dirname, "server.js")],
        });

        await this.client.connect(transport);
        console.log("Connected to internal MCP server");
    }

    async callTool(name, args) {
        try {
            const result = await this.client.callTool({
                name,
                arguments: args
            });
            return result;
        } catch (error) {
            console.error(`MCP Tool Call Error (${name}):`, error.message);
            return { content: [{ type: "text", text: `Error: ${error.message}` }] };
        }
    }
}

module.exports = new McpClient();
