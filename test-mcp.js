const mcpClient = require("./mcp/client");

async function test() {
    try {
        await mcpClient.connect();
        
        console.log("\n--- Testing get_calendar_events ---");
        const calResult = await mcpClient.callTool("get_calendar_events", { date: "12/04/2026" });
        console.log(JSON.stringify(calResult, null, 2));

        console.log("\n--- Testing get_tasks ---");
        const tasksResult = await mcpClient.callTool("get_tasks", {});
        console.log(JSON.stringify(tasksResult, null, 2));

        console.log("\n--- Testing add_task ---");
        const addTaskResult = await mcpClient.callTool("add_task", { title: "Test task from MCP", due: "2026-04-18" });
        console.log(JSON.stringify(addTaskResult, null, 2));

        console.log("\n--- Testing get_chat_history ---");
        // Use a dummy phone number or one from your DB
        const chatResult = await mcpClient.callTool("get_chat_history", { phoneNumber: "0000000000" });
        console.log(JSON.stringify(chatResult, null, 2));

        process.exit(0);
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

test();
