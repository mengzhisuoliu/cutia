import { generateUUID } from "@/utils/id";
import { streamChatCompletion } from "./llm-client";
import { buildSystemPrompt } from "./system-prompt";
import { getAllToolSchemas, getToolByName } from "./tools";
import type { AgentTool } from "./tools/types";
import type {
	AgentLLMConfig,
	AgentMessage,
	AgentToolResult,
	OpenAIChatMessage,
	PendingToolConfirmation,
} from "./types";

const MAX_TOOL_ROUNDS = 20;

export interface AgentServiceCallbacks {
	onMessageStart: () => void;
	onContentDelta: (delta: string) => void;
	onContentDone: (fullContent: string) => void;
	onToolCallStart: (toolCall: {
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	}) => void;
	onToolCallResult: (toolCall: {
		id: string;
		name: string;
		result: AgentToolResult;
	}) => void;
	onMessagesUpdated: (messages: AgentMessage[]) => void;
	onConfirmationRequired: (
		confirmation: PendingToolConfirmation,
	) => Promise<boolean>;
	onDone: () => void;
	onError: (error: Error) => void;
}

function agentMessagesToOpenAI({
	messages,
}: {
	messages: AgentMessage[];
}): OpenAIChatMessage[] {
	return messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
				return {
					role: "assistant" as const,
					content: m.content || null,
					tool_calls: m.toolCalls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					})),
				};
			}

			if (m.role === "tool") {
				return {
					role: "tool" as const,
					content: m.content,
					tool_call_id: m.toolCallId ?? "",
				};
			}

			return {
				role: m.role as "user" | "assistant",
				content: m.content,
			};
		});
}

interface ToolCallEntry {
	rawToolCall: { id: string; name: string; arguments: string };
	parsedArgs: Record<string, unknown>;
	tool: AgentTool | undefined;
}

function pushToolResult({
	conversationMessages,
	callbacks,
	toolCallId,
	toolName,
	result,
}: {
	conversationMessages: AgentMessage[];
	callbacks: AgentServiceCallbacks;
	toolCallId: string;
	toolName: string;
	result: AgentToolResult;
}): void {
	conversationMessages.push({
		id: generateUUID(),
		role: "tool",
		content: JSON.stringify(result),
		toolCallId,
		toolName,
		timestamp: Date.now(),
	});
	callbacks.onMessagesUpdated(conversationMessages);
	callbacks.onToolCallResult({ id: toolCallId, name: toolName, result });
}

async function executeAndPushResult({
	tool,
	parsedArgs,
	rawToolCall,
	conversationMessages,
	callbacks,
}: {
	tool: AgentTool;
	parsedArgs: Record<string, unknown>;
	rawToolCall: { id: string; name: string };
	conversationMessages: AgentMessage[];
	callbacks: AgentServiceCallbacks;
}): Promise<void> {
	let result: AgentToolResult;
	try {
		result = await tool.execute(parsedArgs);
	} catch (error) {
		result = {
			success: false,
			message:
				error instanceof Error
					? error.message
					: "Tool execution failed",
		};
	}
	pushToolResult({
		conversationMessages,
		callbacks,
		toolCallId: rawToolCall.id,
		toolName: rawToolCall.name,
		result,
	});
}

async function executeToolCallBatch({
	batch,
	conversationMessages,
	callbacks,
}: {
	batch: ToolCallEntry[];
	conversationMessages: AgentMessage[];
	callbacks: AgentServiceCallbacks;
}): Promise<void> {
	const settled = await Promise.all(
		batch
			.filter(
				(entry): entry is ToolCallEntry & { tool: AgentTool } =>
					entry.tool != null,
			)
			.map(async ({ rawToolCall, parsedArgs, tool }) => {
				callbacks.onToolCallStart({
					id: rawToolCall.id,
					name: rawToolCall.name,
					arguments: parsedArgs,
				});
				let result: AgentToolResult;
				try {
					result = await tool.execute(parsedArgs);
				} catch (error) {
					result = {
						success: false,
						message:
							error instanceof Error
								? error.message
								: "Tool execution failed",
					};
				}
				return { rawToolCall, result };
			}),
	);

	for (const { rawToolCall, result } of settled) {
		pushToolResult({
			conversationMessages,
			callbacks,
			toolCallId: rawToolCall.id,
			toolName: rawToolCall.name,
			result,
		});
	}
}

export async function runAgentLoop({
	config,
	messages,
	autoMode,
	callbacks,
	signal,
}: {
	config: AgentLLMConfig;
	messages: AgentMessage[];
	autoMode: boolean;
	callbacks: AgentServiceCallbacks;
	signal: AbortSignal;
}): Promise<AgentMessage[]> {
	const systemPrompt = buildSystemPrompt();
	const toolSchemas = getAllToolSchemas();
	const conversationMessages = [...messages];
	let rounds = 0;

	while (rounds < MAX_TOOL_ROUNDS) {
		if (signal.aborted) break;
		rounds++;

		callbacks.onMessageStart();

		const openaiMessages: OpenAIChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...agentMessagesToOpenAI({ messages: conversationMessages }),
		];

		const result = await streamChatCompletion({
			config,
			messages: openaiMessages,
			tools: toolSchemas,
			callbacks: {
				onContent: (delta) => callbacks.onContentDelta(delta),
				onDone: () => {},
				onError: (error) => callbacks.onError(error),
			},
			signal,
		});

		if (signal.aborted) break;

		const assistantMessage: AgentMessage = {
			id: generateUUID(),
			role: "assistant",
			content: result.content,
			timestamp: Date.now(),
			toolCalls:
				result.toolCalls.length > 0
					? result.toolCalls.map((tc) => ({
							id: tc.id,
							name: tc.name,
							arguments: JSON.parse(tc.arguments || "{}"),
						}))
					: undefined,
		};

		conversationMessages.push(assistantMessage);
		callbacks.onMessagesUpdated(conversationMessages);

		if (result.content) {
			callbacks.onContentDone(result.content);
		}

		if (!result.toolCalls || result.toolCalls.length === 0) {
			break;
		}

		const toolCallEntries = result.toolCalls.map((rawToolCall) => ({
			rawToolCall,
			parsedArgs: JSON.parse(rawToolCall.arguments || "{}") as Record<
				string,
				unknown
			>,
			tool: getToolByName({ name: rawToolCall.name }),
		}));

		const confirmableEntries = toolCallEntries.filter(
			(
				entry,
			): entry is ToolCallEntry & { tool: AgentTool } =>
				entry.tool?.requiresConfirmation === true && !autoMode,
		);

		const confirmedIds = new Set<string>();
		if (confirmableEntries.length > 0) {
			const userConfirmed = await callbacks.onConfirmationRequired({
				toolCalls: confirmableEntries.map(
					({ rawToolCall, parsedArgs, tool }) => ({
						toolCallId: rawToolCall.id,
						toolName: rawToolCall.name,
						arguments: parsedArgs,
						description: tool.description,
					}),
				),
			});
			if (userConfirmed) {
				for (const { rawToolCall } of confirmableEntries) {
					confirmedIds.add(rawToolCall.id);
				}
			}
		}

		let entryIndex = 0;
		while (entryIndex < toolCallEntries.length && !signal.aborted) {
			const entry = toolCallEntries[entryIndex];
			const { rawToolCall, parsedArgs, tool } = entry;

			if (!tool) {
				pushToolResult({
					conversationMessages,
					callbacks,
					toolCallId: rawToolCall.id,
					toolName: rawToolCall.name,
					result: {
						success: false,
						message: `Unknown tool: ${rawToolCall.name}`,
					},
				});
				entryIndex++;
				continue;
			}

			const needsConfirmation =
				tool.requiresConfirmation && !autoMode;

			if (needsConfirmation && !confirmedIds.has(rawToolCall.id)) {
				pushToolResult({
					conversationMessages,
					callbacks,
					toolCallId: rawToolCall.id,
					toolName: rawToolCall.name,
					result: {
						success: false,
						message:
							"User skipped this operation. Please continue with alternative approaches or ask the user for guidance.",
					},
				});
				entryIndex++;
				continue;
			}

			if (needsConfirmation && confirmedIds.has(rawToolCall.id)) {
				const batch = [entry];
				let nextIndex = entryIndex + 1;
				while (nextIndex < toolCallEntries.length) {
					const next = toolCallEntries[nextIndex];
					const nextNeedsConfirm =
						next.tool?.requiresConfirmation && !autoMode;
					if (
						!nextNeedsConfirm ||
						!confirmedIds.has(next.rawToolCall.id)
					)
						break;
					batch.push(next);
					nextIndex++;
				}

				await executeToolCallBatch({
					batch,
					conversationMessages,
					callbacks,
				});
				entryIndex = nextIndex;
				continue;
			}

			callbacks.onToolCallStart({
				id: rawToolCall.id,
				name: rawToolCall.name,
				arguments: parsedArgs,
			});
			await executeAndPushResult({
				tool,
				parsedArgs,
				rawToolCall,
				conversationMessages,
				callbacks,
			});
			entryIndex++;
		}
	}

	callbacks.onDone();
	return conversationMessages;
}
