# MCP Bedrock Converse Client

This project is a command-line interface (CLI) client that demonstrates how to use Amazon Bedrock's `Converse` API with an external Model Context Protocol (MCP) server for enabling tool use with language models.

The client connects to a specified MCP server, lists the available tools, and then allows the user to interact with a Bedrock language model (specifically configured for Anthropic Claude 3 Sonnet). When the Bedrock model decides to use a tool, this client facilitates the call to the MCP server and sends the results back to Bedrock for further processing and response generation.

## Features

-   Connects to an MCP-compliant tool server.
-   Interacts with Amazon Bedrock's `Converse` API.
-   Supports tool use by bridging Bedrock's tool use requests to an MCP server.
-   Handles retries with exponential backoff for MCP tool calls.
-   Handles retries with a fixed (configurable) delay for Bedrock API throttling exceptions.
-   Deduplicates identical tool call requests from Bedrock within a single turn.
-   Provides a chat interface for interactive conversations with the Bedrock model.

## Prerequisites

-   Node.js (v18 or higher recommended)
-   npm (usually comes with Node.js)
-   AWS Credentials configured in your environment, with permissions to invoke Amazon Bedrock models.
    (e.g., via AWS CLI `aws configure` or environment variables)
-   An MCP-compliant tool server running and accessible. The path to this server's startup script is required for configuration.

## Project Structure

```
mcp-bedrock-converse/
├── build/                  # Compiled JavaScript output
├── node_modules/           # Node.js dependencies
├── src/
│   └── index.ts            # Main TypeScript source code for the client
├── package.json            # Project metadata and dependencies
├── package-lock.json       # Exact versions of dependencies
├── tsconfig.json           # TypeScript compiler options
└── README.md               # This file
```

## Setup and Installation

1.  **Clone the repository (if applicable) or ensure you have the project files.**
2.  **Navigate to the project directory:**
    ```bash
    cd mcp-bedrock-converse
    ```
3.  **Install dependencies:**
    ```bash
    npm install
    ```
4.  **Configure the MCP Server Path:**
    Open `src/index.ts` and locate the `main()` function towards the end of the file.
    Modify the `serverScriptPath` argument in the `client.connectToMcpServer()` call to point to your MCP server's executable script. For example:

    ```typescript
    async function main() {
        try {
            // Update this path to your MCP server script
            await client.connectToMcpServer('/path/to/your/mcp-server/script.js'); 
            await client.chat();
        } catch (e) {
            console.error("Unhandled error in main execution:", e);
            process.exit(1);
        }
    }
    ```
    The default path is currently set to: `/Users/m858450/Documents/mcp-scheduler-bot/build/index.js`. You **must** change this if your MCP server is located elsewhere or has a different startup script.

5.  **Configure Bedrock Model ID (Optional):**
    The Bedrock Model ID is set in `src/index.ts`:
    ```typescript
    const modelId = 'arn:aws:bedrock:us-east-2:116981798676:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0'
    ```
    You can change this if you wish to use a different Bedrock model that supports the Converse API and tool use. Ensure the AWS region in the `BedrockRuntimeClient` constructor (currently `us-east-2`) is compatible with your chosen model and AWS setup.

## Building the Project

After any changes to the `src/index.ts` file, you need to compile the TypeScript code:

```bash
npm run build
```
This command runs `tsc` (TypeScript compiler) and makes the output script executable.

## Running the Client

Once set up and built, you can run the client:

```bash
npm run converse
```
This will start the client. It will first attempt to connect to your configured MCP server. If successful, it will list the available tools from the MCP server and then present you with a chat prompt (e.g., `Whats up?`).

You can then start conversing with the Bedrock model. If the model decides to use a tool provided by your MCP server, the client will handle the interaction.

**Example Interaction:**

```
$ npm run converse

> mcp-bedrock-converse@1.0.0 converse
> node build/index.js

Available MCP tools: [
  {
    "name": "get_facilities",
    "description": "Retrieves a list of medical facilities.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "includeDetails": {
          "type": "boolean",
          "description": "Set to true to include detailed information for each facility."
        }
      }
    }
  },
  // ... other tools ...
]
Whats up? > Tell me about the facilities.
Executing MCP tool call for: get_facilities { includeDetails: true }
MCP tool get_facilities call successful (attempt 1)
Successfully processed tool get_facilities for ID tooluse_xxxx (via promise): { ... raw JSON from tool ... }
[DEBUG] Tool results added. Looping back to Bedrock for processing.
# Your Practice Fusion Facilities
... (Bedrock's summarized response) ...
? > 
```

To exit the chat, press `Enter` at an empty prompt or use `Ctrl+C`.

## How Tool Use Works

1.  The user sends a message.
2.  The `ConverseMcpClient` sends this to Amazon Bedrock.
3.  If Bedrock determines a tool is needed, it responds with a `stopReason: 'tool_use'` and details of the tool to call (name, arguments, `toolUseId`).
4.  The client's `converse()` method detects this, finds the `toolUse` block.
5.  It checks a local cache (`toolCallPromises`) to see if an identical tool call has already been initiated *in the current turn from Bedrock*.
    -   If yes, it reuses the promise for that call.
    -   If no, it initiates a new call to the MCP server using `this.mcp.callTool()`. This call has its own retry logic (3 attempts with exponential backoff). The promise for this call is cached.
6.  Once the MCP tool call promise resolves (either with data or an error after retries):
    -   The client constructs a `toolResult` message (with the original `toolUseId`).
    -   This `toolResult` message is added to the conversation history.
7.  The `chat()` loop detects that tool results were added and immediately calls `converse()` again.
8.  The updated conversation history (including the `toolResult`) is sent back to Bedrock.
9.  Bedrock processes the tool's output and generates a natural language response for the user.
10. If Bedrock's API call results in a `ThrottlingException`, the client waits for 2.5 seconds and retries the Bedrock call.

## Troubleshooting

-   **`Failed to connect to MCP server...`**:
    -   Ensure your MCP server is running.
    -   Verify the `serverScriptPath` in `src/index.ts` is correct and points to an executable script that starts your MCP server in stdio mode.
    -   Check for any errors from the MCP server itself in its own logs.
-   **AWS Credentials Error**:
    -   Make sure your AWS credentials are correctly configured in your environment and have permissions for Bedrock.
-   **`Rate limit exceeded. Waiting before retrying...`**:
    -   This is from the Bedrock API. The client has retry logic. If it happens very frequently, you might be exceeding your Bedrock API quotas. The current retry delay is 2.5 seconds.
-   **Tool call errors (`Error calling MCP tool ...`)**:
    -   These errors originate from your MCP tool server or issues during the MCP communication. Check the MCP server logs for details. The client will retry MCP tool calls up to 3 times.
-   **Incorrect Tool Behavior/Output**:
    -   This usually points to an issue with the tool implementation on the MCP server side.
-   **TypeScript Compilation Errors**:
    -   Ensure you have a compatible version of Node.js and TypeScript. Check `tsconfig.json` for settings.
    -   Run `npm install` to ensure all devDependencies (like `typescript` and `@types/node`) are installed.
``` 