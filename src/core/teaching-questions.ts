import type { LhMessage } from "./native-messages.ts";
import { buildAnswer, normalizeOptions, normalizeQuizType, resolveCorrect, seededRandom, shuffleOptions, type QuestionAnswerData, type QuestionData } from "./question-core.ts";
import { parseExplainInput, parseQuizInput } from "./tool-parts.ts";

export const RETRY_QUESTION_TOOL = "retry_question";
export const REVEAL_SOLUTION_TOOL = "reveal_solution";

type TeachingCall = { id: string; name: string; arguments: Record<string, unknown> };
export interface TeachingQuestion {
	call: TeachingCall;
	root: TeachingCall;
	tool: "quiz" | "explain";
	input: Record<string, unknown>;
	answer?: QuestionAnswerData;
	revealed: boolean;
}

/** Resolve only an unambiguous occurrence in THIS chat. Never choose an
 * arbitrary historical call when a provider reused an id. */
export function teachingQuestion(messages: readonly LhMessage[], id: string): TeachingQuestion {
	const calls = messages.flatMap(message => message.role === "assistant"
		? message.content.filter(block => block.type === "toolCall" && block.id === id)
			.map(block => ({ block, message })) : []);
	if (calls.length !== 1) throw new Error("Question reference is unresolved or ambiguous in this chat.");
	const { block, message } = calls[0]!;
	if (block.type !== "toolCall" || message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error("Question belongs to a failed or aborted generation.");
	}
	const call: TeachingCall = { id: block.id, name: block.name, arguments: block.arguments };
	const position = messages.indexOf(message);
	const result = messages.slice(position + 1).find(m => m.role === "toolResult" && m.toolCallId === id && m.toolName === block.name && (m.isError || m.details != null));
	if (result?.role === "toolResult" && result.isError) throw new Error("Question failed validation.");
	let root = call;
	if (call.name === RETRY_QUESTION_TOOL) {
		const source = call.arguments.questionToolCallId;
		if (typeof source !== "string") throw new Error("Retry has no question reference.");
		// References must point backwards, so corrupt cycles cannot recurse.
		root = teachingQuestion(messages.slice(0, position), source).root;
	}
	if (root.name !== "quiz" && root.name !== "explain") throw new Error("Reference is not a teaching question.");
	const parsed = root.name === "quiz" ? parseQuizInput(root.arguments) : parseExplainInput(root.arguments);
	if (!parsed || typeof root.arguments.nodeId !== "string") throw new Error("Reference is not a valid teaching question.");
	const input: Record<string, unknown> = { ...root.arguments, ...parsed };
	if (call.name === RETRY_QUESTION_TOOL) Object.assign(input, { arrival: "open", solution: "deferred" });
	const revealed = parsed.solution !== "deferred" || messages.some(m =>
		(m.role === "custom" && m.customType === "solution-revealed" &&
			(m.details as { questionToolCallId?: string })?.questionToolCallId === root.id) ||
		(m.role === "toolResult" && m.toolName === REVEAL_SOLUTION_TOOL && !m.isError &&
			(m.details as { ok?: boolean; questionToolCallId?: string } | null)?.ok === true &&
			(m.details as { questionToolCallId?: string }).questionToolCallId === root.id));
	return { call, root, tool: root.name, input, answer: result?.role === "toolResult" ? result.details as unknown as QuestionAnswerData : undefined, revealed };
}

export function latestTeachingAttempt(messages: readonly LhMessage[], question: TeachingQuestion): boolean {
	let latest = question.root.id;
	for (const message of messages) {
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== RETRY_QUESTION_TOOL) continue;
			try {
				if (teachingQuestion(messages, block.id).root.id === question.root.id) latest = block.id;
			} catch { /* failed attempts carry no question authority */ }
		}
	}
	return latest === question.call.id;
}

/** Display-only resolution; raw calls and model history are never rewritten. */
export function teachingQuestionView(messages: readonly LhMessage[], id: string): TeachingQuestion | undefined {
	try { return teachingQuestion(messages, id); } catch { return undefined; }
}

/** Authoritative content and deterministic grading come from the saved
 * commitment. The learner supplies only selections, text and thinking. */
export function canonicalTeachingAnswer(q: TeachingQuestion, answer?: QuestionAnswerData): QuestionAnswerData {
	const quiz = q.tool === "quiz" ? parseQuizInput(q.input) : undefined;
	const explain = q.tool === "explain" ? parseExplainInput(q.input) : undefined;
	const options = quiz ? shuffleOptions(normalizeOptions(quiz.options), seededRandom(q.call.id)) : [];
	const data: QuestionData = {
		id: q.call.id, kind: q.tool, question: String(q.input.question),
		questionType: normalizeQuizType(q.input.type), solution: q.input.solution as QuestionData["solution"],
		mode: quiz ? quiz.multiSelect ? "multi-select" : "single-select" : "text", options,
		correctIndices: quiz ? resolveCorrect(quiz.correctAnswer, options).indices : undefined,
		explanation: quiz?.explanation, committedAnswer: explain?.correctAnswer, createdAt: new Date().toISOString(),
	};
	const result = buildAnswer(data, {
		values: answer?.answers?.map(a => a.value), text: answer?.text, other: answer?.other,
		thinking: answer?.thinking ?? answer?.note, readingThinking: answer?.readingThinking,
		confidence: answer?.confidence, dontKnow: answer?.dontKnow,
	}, q.call.name);
	if (answer?.answeredAt) result.answeredAt = answer.answeredAt;
	if (!answer) { result.solutionRequested = true; delete result.correct; }
	if (answer?.dismissed) result.dismissed = true;
	return result;
}

/** Keep the original commitment available even when its call has fallen
 * outside the model's compaction window. */
export function teachingSolutionText(q: TeachingQuestion): string {
	const answer = canonicalTeachingAnswer(q);
	if (answer.committed) return answer.committed;
	const correct = answer.options?.filter(option => answer.correctIndices?.includes(option.index)).map(option => option.label).join("; ");
	return [correct, answer.explanation].filter(Boolean).join("\n\n");
}
