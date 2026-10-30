import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PlanToolContext } from "./plan.ts";
import { questionResult, invalidInputResult } from "../tool-execute.ts";
import { danglingQuestionOf } from "../../core/native-messages.ts";
import { teachingQuestion, latestTeachingAttempt, teachingSolutionText } from "../../core/teaching-questions.ts";

const reference = Type.Object({ questionToolCallId: Type.String({ minLength: 1 }) });

export function teachingFeedbackTools(ctx: PlanToolContext): Record<string, AgentTool<any>> {
	const revealed = new Set<string>();
	let retryPosed = false;
	return {
		retry_question: {
			name: "retry_question", label: "retry_question", parameters: reference, executionMode: "sequential",
			description: "Pose another attempt at an answered teaching question without changing its question, options, committed solution, or plan node. Give any targeted hint in learner-facing prose before calling this tool. The retry opens immediately, keeps the solution deferred, and ends your turn.",
			execute: async (_id, input) => {
				try {
					const record = ctx.chatStore.getChat(ctx.chatId);
					if (!record) throw new Error("Chat not found.");
					if (danglingQuestionOf(record.messages)) throw new Error("Resolve the open question first.");
					if (retryPosed) throw new Error("Resolve the open question first.");
					const q = teachingQuestion(record.messages, (input as { questionToolCallId: string }).questionToolCallId);
					if (!q.answer || q.answer.dismissed || q.answer.solutionRequested) throw new Error("Retry requires an answered, non-dismissed question.");
					if (q.revealed || revealed.has(q.root.id)) throw new Error("The solution is already revealed. Use a fresh question to check independence.");
					if (!latestTeachingAttempt(record.messages, q)) throw new Error("Reference the latest answered attempt in this chain.");
					if (!record.tree?.nodes.some(node => node.id === q.input.nodeId)) throw new Error("The question's node is missing from the current map. Update the map first.");
					retryPosed = true;
					return questionResult();
				} catch (error) {
					return invalidInputResult("retry_question", [error instanceof Error ? error.message : String(error)]);
				}
			},
		},
		reveal_solution: {
			name: "reveal_solution", label: "reveal_solution", parameters: reference, executionMode: "sequential",
			description: "Reveal the original committed solution for an answered teaching question and its retries. The solution comes from the saved question, not newly supplied text. This action does not end your turn; continue with any targeted explanation or follow-up.",
			execute: async (_id, rawInput) => {
				const input = rawInput as { questionToolCallId: string };
				try {
					const record = ctx.chatStore.getChat(ctx.chatId);
					if (!record) throw new Error("Chat not found.");
					if (retryPosed) throw new Error("Resolve the open question first.");
					if (danglingQuestionOf(record.messages)) throw new Error("Resolve the open question first.");
					const q = teachingQuestion(record.messages, input.questionToolCallId);
					if (!q.answer || q.answer.dismissed) throw new Error("Reveal requires an answered question.");
					revealed.add(q.root.id);
					return { content: [{ type: "text" as const, text: `The original committed solution is revealed. Continue with targeted explanation or follow-up.\nQuestion: ${q.input.question}\nCommitted solution:\n${teachingSolutionText(q)}` }], details: { ok: true, questionToolCallId: q.root.id } };
				} catch (error) {
					return invalidInputResult("reveal_solution", [error instanceof Error ? error.message : String(error)]);
				}
			},
		},
	};
}
