Kia ora builders, are you using the Bedrock Converse API and need to use other resources or tools? The Model Context Protocol (MCP) is an open protocol you can use but you need to build a client to proxy requests between Bedrock and your MCP server.
This post shows how to build a MCP Client using the MCP Typescript SDK. Giuseppe Battista did a great job explaining the concept in Python, so I won't rehash the theory and just get down into the code.
Setup the project
Create and initiate the project:
1
2
3
4
5
6
7
mkdir mcp-bedrock-converse
cd mcp-bedrock-converse
npm init -y
npm install @aws-sdk/client-bedrock-runtime @modelcontextprotocol/sdk @inquirer/prompts
npm i --save-dev @types/node
mkdir src
touch src/index.ts
Add the following to package.json
1
2
3
4
5
6
7
{
  "scripts": {
    "build": "tsc && chmod 755 build/index.js",
    "converse": "node build/index.js",
  },
  "type": "module",
}
Create a tsconfig.json
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "node_modules"
  ]
}
MCP Converse Client code
Add the following to src/index.ts
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
61
62
63
64
65
66
67
68
69
70
71
72
73
74
75
76
77
78
79
80
81
82
83
84
85
86
87
88
89
90
91
92
93
94
95
96
97
98
99
100
101
102
103
104
105
106
107
108
109
110
111
112
113
114
115
116
117
118
119
120
121
122
123
124
125
126
127
128
129
130
131
132
133
134
135
136
137
138
139
140
141
142
143
144
145
146
147
148
import { BedrockRuntimeClient, ConverseCommand, ConverseCommandInput, Message, Tool, ToolInputSchema } from "@aws-sdk/client-bedrock-runtime";
import { input } from "@inquirer/prompts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

class ConverseMcpClient {
    private mcp: Client // from "@modelcontextprotocol/sdk/client/index.js"
    private bedrock: BedrockRuntimeClient
    private transport: StdioClientTransport | null = null; // from "@modelcontextprotocol/sdk/client/stdio.js"
    private tools: Tool[] = []
    constructor(modelId: string) {
        this.bedrock = new BedrockRuntimeClient({ region: 'us-east-1' })
        this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" })
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
            this.mcp.connect(this.transport);

            // List available tools
            const toolsResult = await this.mcp.listTools();

            this.tools = toolsResult.tools.map((tool) => {
                const toolInputSchema: ToolInputSchema = {
                    json: JSON.parse(JSON.stringify(tool.inputSchema))
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
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }
    async converse(conversation: Message[]) {
        const input: ConverseCommandInput = {
            modelId: modelId,
            messages: conversation
        }
        if (this.tools.length > 0) {
            input.toolConfig = {
                tools: this.tools
            }
        }
        const response = await this.bedrock.send(
            new ConverseCommand(input),
        );

        if (response.stopReason === 'tool_use') {
            if (response.output?.message?.content) {
                const message = response.output.message
                conversation.push(message)
                const content = response.output?.message?.content
                for (var contentBlock of content) {
                    if (contentBlock.toolUse?.name) {
                        const toolName = contentBlock.toolUse.name
                        const toolArguments = JSON.parse(JSON.stringify(contentBlock.toolUse.input))
                        const response = await client.mcp.callTool({
                            name: toolName,
                            arguments: toolArguments
                        })
                        const message: Message = {
                            role: "user",
                            content: [{
                                toolResult: {
                                    toolUseId: contentBlock.toolUse.toolUseId,
                                    content: [{
                                        text: JSON.stringify(response)
                                    }]
                                }
                            }]
                        }
                        conversation.push(message)
                        await this.converse(conversation)
                    }
                }
        
            }
        }
        else if (response.output?.message) {
            const message = response.output.message
            console.log(message.content?.[0].text);
            conversation.push(message)
        }
    }

    async questionPrompt(message: string, conversation: Message[]): Promise<boolean> {
        const answer = await input({ message: message })
        if (answer) {
            const question: Message = {
                role: "user",
                content: [{ text: answer }],
            }
            conversation.push(question)
            return true
        }
        else {
            return false;
        }
    }

    async chat() {
        const conversation: Message[] = []
        try {
            if (await this.questionPrompt('Whats up?', conversation)) {
                while (true) {
                    await client.converse(conversation)
                    if (!await this.questionPrompt('', conversation)) { break }
                }
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'ExitPromptError') {
                // noop; silence this error
            } else {
                console.error(error)
                throw error;
            }
        }
    }
}

const modelId = 'anthropic.claude-3-haiku-20240307-v1:0'
const client = new ConverseMcpClient(modelId)
//await client.connectToMcpServer('/path/to/mcp/index.js')
await client.chat()
You can build and run the code with the following:
1
2
npm run build
npm run converse
Right now, it is a basic interface to talk to a Bedrock model. If you have an MCP server, then add it with await client.connectToMcpServer('/path/to/mcp/index.js') where indicated in the code.
Inspecting the code
Constructor
1
2
3
4
5
6
    private mcp: Client // from "@modelcontextprotocol/sdk/client/index.js"
    private bedrock: BedrockRuntimeClient
    constructor(modelId: string) {
        this.bedrock = new BedrockRuntimeClient({ region: 'us-east-1' })
        this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" })
    }
This creates a Bedrock Runtime Client to use Bedrock models and a MCP Client to interact with MCP servers.
MCP server connection
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
    private transport: StdioClientTransport | null = null; // from "@modelcontextprotocol/sdk/client/stdio.js"
    private tools: Tool[] = []
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
            this.mcp.connect(this.transport);

            // List available tools
            const toolsResult = await this.mcp.listTools();

            this.tools = toolsResult.tools.map((tool) => {
                const toolInputSchema: ToolInputSchema = {
                    json: JSON.parse(JSON.stringify(tool.inputSchema))
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
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }
This will take a MCP server script path and connect to it using the MCP client over Stdio.
It then adds the MCP server to a list of tools which are available to Bedrock and supplied when we converse with it.
Converse
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
    async converse(conversation: Message[]) {
        const input: ConverseCommandInput = {
            modelId: modelId,
            messages: conversation
        }
        if (this.tools.length > 0) {
            input.toolConfig = {
                tools: this.tools
            }
        }
        const response = await this.bedrock.send(
            new ConverseCommand(input),
        );

        if (response.stopReason === 'tool_use') {
            if (response.output?.message?.content) {
                const message = response.output.message
                conversation.push(message)
                const content = response.output?.message?.content
                for (var contentBlock of content) {
                    if (contentBlock.toolUse?.name) {
                        const toolName = contentBlock.toolUse.name
                        const toolArguments = JSON.parse(JSON.stringify(contentBlock.toolUse.input))
                        const response = await client.mcp.callTool({
                            name: toolName,
                            arguments: toolArguments
                        })
                        const message: Message = {
                            role: "user",
                            content: [{
                                toolResult: {
                                    toolUseId: contentBlock.toolUse.toolUseId,
                                    content: [{
                                        text: JSON.stringify(response)
                                    }]
                                }
                            }]
                        }
                        conversation.push(message)
                        await this.converse(conversation)
                    }
                }
        
            }
        }
        else if (response.output?.message) {
            const message = response.output.message
            console.log(message.content?.[0].text);
            conversation.push(message)
        }
    }
This is where the magic happens. When you use Converse, you supply a conversation of all the messages between the user and assistant.
So, we take a conversation of Bedrock Messages and send a ConverseCommand along with the tools (MCP servers) we have available to use (if any).
If Bedrock wants to use one of these tools, then the response will have a stopReason of tool_use. This is documented here. We then have to call the correct tool using client.mcp.callTool and return the response to Bedrock along with the toolUseId which was given by Bedrock in the tool_use request.
Lo-fi chat interface
We need an interface, so I've used Inquirer.js for this in a basic way. The code below takes input and maintains a conversation loop until the user exits (blank message). Nothing radical here.
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
    async questionPrompt(message: string, conversation: Message[]): Promise<boolean> {
        const answer = await input({ message: message })
        if (answer) {
            const question: Message = {
                role: "user",
                content: [{ text: answer }],
            }
            conversation.push(question)
            return true
        }
        else {
            return false;
        }
    }

    async chat() {
        const conversation: Message[] = []
        try {
            if (await this.questionPrompt('Whats up?', conversation)) {
                while (true) {
                    await client.converse(conversation)
                    if (!await this.questionPrompt('', conversation)) { break }
                }
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'ExitPromptError') {
                // noop; silence this error
            } else {
                console.error(error)
                throw error;
            }
        }
    }
Summary
It's still early days with MCP, but we can already see potential in such tools to make our AI agents more useful.
In this post, I showed how to implement a MCP Client in Typescript to proxy requests to MCP servers so that Bedrock Converse can be used with external tools.
Hopefully it's useful for someone, keep on rocking innovation and be the best builder you can be!
Cheers, Dave
 
Any opinions in this post are those of the individual author and may not reflect the opinions of AWS.


Like (6)
Comments (2)

Share

2 Comments
Log in to comment

Sort by: Top
User avatar
Giuseppe Battista
Apr 3
whoop whoop! Love your typescript implementation! Thanks for quoting the article too <3

Like (1)

Reply

Share

Elijah
May 2
Great article! Would love to see one using the new streamablehttp!

Like

Reply

Share