import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Value } from "typebox/value";
import { AnsweredCard } from "../components/answered-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { canonicalTeachingAnswer, teachingQuestion } from "../src/core/teaching-questions.ts";
import { dismissAppends, inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { danglingQuestionOf, pendingQuestionOf, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { explainInputObject, quizInputObject, questionNeedsReveal, teachingQuestionProblems } from "../src/core/question-core.ts";
import { derivePlanStatusesLh } from "../src/core/contracts/plan.ts";
import { createProberTools, createTeacherTools, teachQuizToolFor } from "../src/agent/tools.ts";
import { teachingFeedbackTools } from "../src/agent/tools/teaching-feedback.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import type { ChatStore } from "../src/core/ports.ts";

const input = {
	nodeId: "arithmetic", type: "attempt", arrival: "open", solution: "deferred",
	question: "What is two plus two? Explain why.",
	options: [{ label: "Three", value: "3" }, { label: "Four", value: "4" }],
	explanation: "Two pairs contain four objects.", correctAnswer: "4",
};
const free = { ...input, correctAnswer: "Four: combining two pairs gives four objects." };
function call(id: string, name: string, args: Record<string, unknown>): LhMessage {
	return {
		id: `message_${id}`, role: "assistant", api: "test", provider: "test", model: "test", stopReason: "toolUse",
		content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as unknown as LhMessage;
}
function fixture(name: "quiz" | "explain" = "quiz") {
	const record = { id: "chat", messages: [call("q1", name, name === "quiz" ? input : free)], tree: { version: 1, nodes: [{ id: "arithmetic", title: "Arithmetic" }], edges: [] } };
	const chatStore = {
		getChat: (id: string) => id === record.id ? record : null,
		saveMessages: (_id: string, messages: LhMessage[]) => { record.messages = messages; },
	} as unknown as ChatStore;
	const ctx = { chatId: record.id, chatStore };
	const answer = () => {
		const q = teachingQuestion(record.messages, "q1");
		const data = canonicalTeachingAnswer(q);
		delete data.solutionRequested;
		data.answers = [{ index: 1, label: "Three", value: "3" }];
		data.text = name === "explain" ? "Three because I counted incorrectly." : undefined;
		record.messages.push(...inputAppends(record, { type: "answer", toolCallId: "q1", answer: data }));
	};
	return { record, ctx, answer };
}
function card(messages: LhMessage[], id = "q1") {
	const part = projectView(messages).flatMap(m => m.parts).find(p => p.toolCallId === id)!;
	return renderToStaticMarkup(<AnsweredCard answer={part.output as never} input={part.input} solutionRevealed={part.solutionRevealed === true} onRequestSolution={() => {}} />);
}

describe("adaptive teaching contract", () => {
	it("requires independent purpose, arrival and solution fields only for teaching", async () => {
		assert.equal(Value.Check(quizInputObject, input), true);
		assert.equal(Value.Check(explainInputObject, free), true);
		for (const field of ["arrival", "solution"]) {
			const malformed = { ...input } as Record<string, unknown>;
			delete malformed[field];
			assert.equal(Value.Check(quizInputObject, malformed), false);
		}
		assert.deepEqual(teachingQuestionProblems(input), []);
		assert.ok(teachingQuestionProblems({ ...input, solution: "on_submit" }).length);
		assert.equal(questionNeedsReveal("quiz", { ...input, type: "check", arrival: "open" }, "teach"), false);
		assert.equal(questionNeedsReveal("explain", { ...free, type: "check", arrival: "after_reading" }, "teach"), true);
		assert.equal(questionNeedsReveal("explain", { ...free, type: "check", arrival: '"open"' }, "teach"), false);
		const { ctx } = fixture();
		assert.equal((await teachQuizToolFor(ctx).execute("bad", { ...input, solution: "on_submit" } as never)).isError, true);
	});
	it("keeps format selection in probing while arming both teaching formats", () => {
		const { ctx } = fixture();
		const extended = { ...ctx, jobStore: {}, spawn: () => {}, deliver: () => {} } as never;
		for (const explain of [true, false]) {
			const teacher = createTeacherTools(extended, { explain });
			for (const name of ["quiz", "explain", "retry_question", "reveal_solution"]) assert.ok(teacher[name]);
			const prober = createProberTools(extended, { explain });
			assert.equal(Boolean(prober.recall), explain);
			assert.equal(Boolean(prober.probe), !explain);
			assert.equal(prober.retry_question, undefined);
		}
	});
	for (const name of ["quiz", "explain"] as const) {
		it(`${name}: hides solutions and verdicts after submit and reload, then reveals the commitment`, async () => {
			const { record, ctx, answer } = fixture(name);
			answer();
			const html = card(JSON.parse(JSON.stringify(record.messages)));
			assert.ok(html.includes("Solution withheld while you work through it."));
			assert.ok(html.includes("Show solution"));
			assert.ok(!html.includes("incorrect</span>"));
			assert.ok(!html.includes("data-mark="));
			assert.ok(!html.includes("Two pairs contain four objects."));
			assert.ok(!html.includes("Four: combining two pairs"));
			const result = await teachingFeedbackTools(ctx).reveal_solution!.execute("reveal", { questionToolCallId: "q1" });
			assert.notEqual(result.isError, true);
			record.messages.push(call("reveal", "reveal_solution", { questionToolCallId: "q1" }), {
				id: "reveal_result", role: "toolResult", toolCallId: "reveal", toolName: "reveal_solution",
				content: result.content, details: result.details, timestamp: 2,
			} as LhMessage);
			assert.equal(teachingQuestion(record.messages, "q1").revealed, true);
			assert.ok(!card(record.messages).includes("Solution withheld"));
			assert.equal((await teachingFeedbackTools(ctx).retry_question!.execute("retry", { questionToolCallId: "q1" })).isError, true);
			assert.notEqual((await teachingFeedbackTools(ctx).reveal_solution!.execute("again", { questionToolCallId: "q1" })).isError, true);
		});
	}
	it("retries preserve immutable content, persist as pending and retain every attempt", async () => {
		const { record, ctx, answer } = fixture();
		answer();
		const result = await teachingFeedbackTools(ctx).retry_question!.execute("r1", { questionToolCallId: "q1" });
		assert.equal(result.terminate, true);
		const messages = [...record.messages, call("r1", "retry_question", { questionToolCallId: "q1" }), {
			id: "placeholder", role: "toolResult", toolCallId: "r1", toolName: "retry_question", content: result.content, details: null, timestamp: 2,
		} as LhMessage];
		persistTurn(ctx.chatStore, "chat", record.messages.length, messages, false);
		assert.equal(record.messages.at(-1)?.role, "assistant");
		const pending = pendingQuestionOf(record.messages)!;
		assert.equal(pending.tool, "retry_question");
		assert.equal(pending.displayTool, "quiz");
		assert.deepEqual(pending.input, input);
		const data = canonicalTeachingAnswer(teachingQuestion(record.messages, "r1"));
		delete data.solutionRequested;
		data.answers = [{ value: "4", label: "Four", index: 2 }];
		assert.doesNotThrow(() => dismissAppends(record, { type: "dismiss", toolCallId: "r1", answer: { ...data, dismissed: true } }));
		record.messages.push(...inputAppends(record, { type: "answer", toolCallId: "r1", answer: data }));
		assert.equal(teachingQuestion(record.messages, "r1").answer?.correct, true);
		assert.equal(teachingQuestion(record.messages, "q1").answer?.correct, false);
		assert.equal((await teachingFeedbackTools(ctx).retry_question!.execute("stale", { questionToolCallId: "q1" })).isError, true);
		assert.equal(derivePlanStatusesLh(record.tree, record.messages).current, "arithmetic");
		assert.equal(teachingQuestion(record.messages, "r1").root.id, "q1");
		assert.equal((await teachingFeedbackTools(ctx).retry_question!.execute("r2", { questionToolCallId: "r1" })).terminate, true);
		record.messages.push(call("r2", "retry_question", { questionToolCallId: "r1" }));
		assert.equal(teachingQuestion(record.messages, "r2").root.id, "q1");
		record.messages.push(...inputAppends(record, { type: "request_solution", toolCallId: "r2" }));
		for (const id of ["q1", "r1", "r2"]) assert.equal(teachingQuestion(record.messages, id).revealed, true);
	});
	it("boundary-healed disclosure fields remain deferred in both rendered formats", () => {
		for (const name of ["quiz", "explain"] as const) {
			const { record } = fixture(name);
			const root = record.messages[0]!;
			if (root.role === "assistant" && root.content[0]?.type === "toolCall") {
				Object.assign(root.content[0].arguments, { type: '"attempt"', arrival: '"open"', solution: '"deferred"' });
			}
			const q = teachingQuestion(record.messages, "q1");
			assert.equal(q.revealed, false);
			assert.equal(q.input.solution, "deferred");
		}
	});
	it("learner solution requests resolve pending questions without an invented wrong answer", () => {
		const { record } = fixture();
		const request = parseChatInput({ type: "request_solution", toolCallId: "q1" });
		record.messages.push(...inputAppends(record, request));
		const q = teachingQuestion(record.messages, "q1");
		assert.equal(q.answer?.solutionRequested, true);
		assert.equal(q.answer?.correct, undefined);
		assert.equal(q.answer?.dontKnow, false);
		assert.equal(q.revealed, true);
		assert.equal(danglingQuestionOf(record.messages), null);
		assert.ok(card(record.messages).includes("Requested the solution."));
		assert.ok(!card(record.messages).includes("incorrect</span>"));
		assert.deepEqual(inputAppends(record, request), []);
	});
	it("rejects foreign, ambiguous, invalid and dismissed sources", async () => {
		const { record, ctx, answer } = fixture();
		assert.throws(() => teachingQuestion([], "q1"));
		assert.throws(() => teachingQuestion([...record.messages, record.messages[0]!], "q1"), /ambiguous/);
		assert.equal((await teachingFeedbackTools(ctx).retry_question!.execute("bad", { questionToolCallId: "q1" })).isError, true);
		answer();
		const q = teachingQuestion(record.messages, "q1");
		q.answer!.dismissed = true;
		assert.equal((await teachingFeedbackTools(ctx).reveal_solution!.execute("bad", { questionToolCallId: "q1" })).isError, true);
		assert.throws(() => inputAppends(record, { type: "request_solution", toolCallId: "foreign" }));
	});
	it("on-submit checks retain immediate disclosure, and pending attempts offer Show solution", () => {
		const { record, answer } = fixture();
		const root = record.messages[0]!;
		if (root.role === "assistant" && root.content[0]?.type === "toolCall") Object.assign(root.content[0].arguments, { type: "check", solution: "on_submit" });
		answer();
		assert.ok(!card(record.messages).includes("Solution withheld"));
		assert.ok(card(record.messages).includes("tucked-explanation"));
		const html = renderToStaticMarkup(<QuestionDock toolName="explain" toolCallId="q1" input={free as never} expanded onExpand={() => {}} onSubmit={() => {}} onRequestSolution={() => {}} />);
		assert.ok(html.includes("Show solution"));
	});
});
