import { BedrockRuntimeClient, ConverseCommand, ConverseCommandInput, Message, Tool, ToolInputSchema, ConversationRole, ContentBlock, ToolResultContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { input } from "@inquirer/prompts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

class ConverseMcpClient {
    private mcp: Client
    private bedrock: BedrockRuntimeClient
    private transport: StdioClientTransport | null = null;
    private tools: Tool[] = []
    private modelId: string;

    constructor(modelId: string) {
        this.bedrock = new BedrockRuntimeClient({ region: 'us-east-2' })
        this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" })
        this.modelId = modelId;
    }
    async connectToMcpServer(serverScriptPath: string) {
        try {
            // Determine script type and appropriate command
            const isJs = serverScriptPath.endsWith(".js");
            const isPy = serverScriptPath.endsWith(".py");
            if (!isJs && !isPy) {
                throw new Error("Server script must be a .js or .py file");
            }
            const command = isPy
                ? process.platform === "win32"
                    ? "python"
                    : "python3"
                : process.execPath;

            // Initialize transport and connect to server
            this.transport = new StdioClientTransport({
                command,
                args: [serverScriptPath],
            });
            await this.mcp.connect(this.transport);

            // List available tools
            const toolsResult = await this.mcp.listTools();
            console.log("Available MCP tools:", JSON.stringify(toolsResult.tools, null, 2));

            this.tools = toolsResult.tools.map((tool) => {
                let parsedInputSchema = {};
                try {
                    if (typeof tool.inputSchema === 'string') {
                        parsedInputSchema = JSON.parse(tool.inputSchema);
                    } else if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
                        parsedInputSchema = tool.inputSchema;
                    } else {
                        console.warn(`Tool ${tool.name} has an invalid inputSchema:`, tool.inputSchema);
                    }
                } catch (e) {
                    console.error(`Failed to parse inputSchema for tool ${tool.name}:`, e, "Schema was:", tool.inputSchema);
                }

                const toolInputSchema: ToolInputSchema = {
                    json: parsedInputSchema
                }
                const bedrockTool: Tool = {
                    toolSpec: {
                        inputSchema: toolInputSchema,
                        name: tool.name,
                        description: tool.description
                    }
                }
                return bedrockTool;
            });
        }
        catch (e) {
            console.log("Failed to connect to MCP server or process tools: ", e);
            throw e;
        }
    }
    async converse(conversation: Message[]): Promise<void> {
        const converseInput: ConverseCommandInput = {
            modelId: this.modelId,
            messages: conversation.map(msg => ({
                role: msg.role,
                content: Array.isArray(msg.content) ? msg.content : (msg.content ? [{ text: String(msg.content) }] : [{text: ""}])
            }))
        }
        if (this.tools.length > 0) {
            converseInput.toolConfig = {
                tools: this.tools
            }
        }
        try {
            const response = await this.bedrock.send(
                new ConverseCommand(converseInput),
            );

            if (response.output?.message) {
                const assistantMessage = response.output.message;
                conversation.push(assistantMessage);

                let toolsWereCalled = false; // Flag to check if we entered tool processing
                if (response.stopReason === 'tool_use' && assistantMessage.content) {
                    toolsWereCalled = true; // Set the flag
                    const toolCallPromises = new Map<string, Promise<any>>(); // Cache for tool call promises
                    for (const contentBlock of assistantMessage.content) {
                        if (contentBlock.toolUse?.toolUseId && contentBlock.toolUse.name && contentBlock.toolUse.input !== undefined) {
                            const toolUseId = contentBlock.toolUse.toolUseId;
                            const toolName = contentBlock.toolUse.name;
                            const toolArguments = contentBlock.toolUse.input;
                            const stringifiedArgs = JSON.stringify(toolArguments);
                            const cacheKey = `${toolName}-${stringifiedArgs}`;

                            console.log(`[DEBUG] Processing ToolUseId: ${toolUseId}, Generated CacheKey: '${cacheKey}' (Args: ${stringifiedArgs})`);
                            console.log(`[DEBUG] Current toolCallPromises keys before 'has' check: ${JSON.stringify(Array.from(toolCallPromises.keys()))}`);

                            let activeToolPromise: Promise<any>;

                            if (toolCallPromises.has(cacheKey)) {
                                console.log(`Reusing active tool call promise for ${toolName} (ID: ${toolUseId}, CacheKey: '${cacheKey}')`);
                                activeToolPromise = toolCallPromises.get(cacheKey)!;
                            } else {
                                console.log(`Initiating new tool call promise for ${toolName} (ID: ${toolUseId}, CacheKey: '${cacheKey}')`);
                                console.log(`[DEBUG] CacheKey '${cacheKey}' NOT found in map. Current keys: ${JSON.stringify(Array.from(toolCallPromises.keys()))}. Setting it now.`);
                                activeToolPromise = (async () => {
                                    // This IIFE performs the actual tool call with its own retry logic
                                    const toolCallPayload = {
                                        name: toolName,
                                        content: [{ text: JSON.stringify(toolArguments) }]
                                    };
                                    // It's good to log the actual attempt here, perhaps not with toolUseId as that's for the outer message
                                    console.log(`Executing MCP tool call for: ${toolName}`, toolArguments);

                                    let attempts = 0;
                                    const maxAttempts = 3;
                                    let currentDelay = 1000;

                                    while (attempts < maxAttempts) {
                                        try {
                                            const responseData = await this.mcp.callTool(toolCallPayload);
                                            console.log(`MCP tool ${toolName} call successful (attempt ${attempts + 1})`);
                                            return responseData; // Promise resolves with data
                                        } catch (toolCallError: any) {
                                            attempts++;
                                            console.error(`Attempt ${attempts} failed for MCP tool ${toolName}:`, toolCallError.message);
                                            if (attempts >= maxAttempts) {
                                                console.error(`Max retries reached for MCP tool ${toolName}. Rethrowing last error.`);
                                                throw toolCallError; // Promise rejects with the error
                                            }
                                            await new Promise(resolve => setTimeout(resolve, currentDelay));
                                            currentDelay *= 2;
                                        }
                                    }
                                    // Fallback error, though theoretically unreachable if maxAttempts > 0
                                    throw new Error(`Max retry attempts for ${toolName} reached, but error not propagated correctly.`);
                                })();
                                toolCallPromises.set(cacheKey, activeToolPromise);
                            }

                            // Now, use this activeToolPromise to generate the response for the current toolUseId
                            try {
                                const toolResponseData = await activeToolPromise;
                                console.log(`Successfully processed tool ${toolName} for ID ${toolUseId} (via promise):`, JSON.stringify(toolResponseData, null, 2));

                                const toolResultMessageContent: ToolResultContentBlock[] = [];
                                if (typeof toolResponseData === 'string') {
                                    toolResultMessageContent.push({ text: toolResponseData });
                                } else if (toolResponseData !== null && typeof toolResponseData === 'object') {
                                    toolResultMessageContent.push({ text: JSON.stringify(toolResponseData) });
                                } else {
                                    toolResultMessageContent.push({ text: "Tool returned non-standard or null data." });
                                }

                                const toolUserMessage: Message = {
                                    role: "user" as ConversationRole,
                                    content: [{
                                        toolResult: {
                                            toolUseId: toolUseId, // Specific to this Bedrock request
                                            content: toolResultMessageContent,
                                        }
                                    }]
                                };
                                conversation.push(toolUserMessage);
                            } catch (error: any) {
                                console.error(`Error handling promise for tool ${toolName}, ID ${toolUseId}:`, error);
                                const errorMessage: Message = {
                                    role: "user" as ConversationRole,
                                    content: [{
                                        toolResult: {
                                            toolUseId: toolUseId, // Specific to this Bedrock request
                                            content: [{ text: `Error during tool execution for ${toolName} (ID: ${toolUseId}): ${error.message || 'Unknown error'}` }],
                                        }
                                    }]
                                };
                                conversation.push(errorMessage);
                            }
                        }
                    }
                }
                
                if (!toolsWereCalled && assistantMessage.content) { 
                    const firstTextContent = assistantMessage.content.find(c => c.text)?.text;
                    if (firstTextContent) {
                        console.log(firstTextContent);
                    } else {
                        console.log("Assistant response received (non-text or empty):", JSON.stringify(assistantMessage.content, null, 2));
                    }
                }
            } else if (response.stopReason) {
                console.log(`Conversation stopped. Reason: ${response.stopReason}`);
            } else {
                console.log("Received an unexpected response structure from Bedrock:", JSON.stringify(response, null, 2));
            }
        } catch (error: any) {
            if (error.name === 'ThrottlingException') {
                console.log('Rate limit exceeded. Waiting before retrying...');
                await new Promise(resolve => setTimeout(resolve, 2500)); // Increased delay to 2500ms
                return this.converse(conversation);
            }
            console.error("Error in Bedrock converse call:", error);
            throw error;
        }
    }

    async questionPrompt(messageText: string, conversation: Message[]): Promise<boolean> {
        const answer = await input({ message: messageText || "> " }); 
        if (answer && answer.trim() !== "") { 
            const question: Message = {
                role: "user" as ConversationRole,
                content: [{ text: answer }]
            };
            conversation.push(question);
            return true;
        } else {
            if (answer === null) return false; 
            return false; 
        }
    }

    async chat() {
        const conversation: Message[] = [];
        try {
            // Initial prompt
            if (!await this.questionPrompt('Whats up?', conversation)) {
                console.log("Chat ended at initial prompt.");
                return;
            }
    
            // Main conversation loop
            while (true) {
                await this.converse(conversation); // Call Bedrock
    
                const lastMessage = conversation[conversation.length - 1];
                // If the last message was a tool result we added, we should loop back to converse()
                // without user input so Bedrock can process it.
                if (lastMessage.role === 'user' && lastMessage.content?.some(c => c.toolResult)) {
                    // Tool results were just added, Bedrock needs to process them. Loop back.
                    console.log("[DEBUG] Tool results added. Looping back to Bedrock for processing.");
                    continue;
                }
    
                // If Bedrock provided a textual response, or if it's waiting for user input after tool use.
                if (!await this.questionPrompt('', conversation)) { // Prompt for next user input
                    break; // User wants to exit
                }
            }
            console.log("Chat ended.");
        } catch (error) {
            if (error instanceof Error && error.name === 'ExitPromptError') {
                console.log("Exiting chat.");
            } else {
                console.error("Chat loop error:", error);
            }
        }
    }
}

const modelId = 'arn:aws:bedrock:us-east-2:116981798676:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0'
const client = new ConverseMcpClient(modelId)

async function main() {
    try {
        await client.connectToMcpServer('/Users/{path}/build/index.js')
        await client.chat()
    } catch (e) {
        console.error("Unhandled error in main execution:", e)
        process.exit(1)
    }
}

main()
