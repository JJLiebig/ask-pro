import type { ChromeClient } from "../types.js";
import type { BrowserLogger } from "../types.js";
import { readComposerSnapshot, submitPrompt } from "./promptComposer.js";

export interface AssistantQuestion {
  question: string;
  options: string[];
  freeText: boolean;
}

export class AssistantQuestionsError extends Error {
  constructor(readonly questions: AssistantQuestion[]) {
    super("ChatGPT is waiting for answers to its questions.");
    this.name = "AssistantQuestionsError";
  }
}

// This function also runs in Chrome; keep it independent of module state.
async function questionCards(
  answers?: Array<number | string>,
  expected?: AssistantQuestion[],
  submission = { started: false },
) {
  const selector = '[data-codex-composer-request-navigation="true"]';
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !node.closest('[inert], [aria-hidden="true"]');
  };
  const card = () => Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible);
  let root = card();
  if (!root) return null;
  // Native pointer interaction cancels ChatGPT's automatic question dismissal.
  root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
  const read = (): AssistantQuestion => {
    root = card();
    if (!root) throw new Error("ChatGPT question card disappeared.");
    return {
      question: root.querySelector<HTMLElement>(".text-size-chat")?.innerText.trim() ?? "",
      options: Array.from(root.querySelectorAll<HTMLElement>('[role="radio"]')).map(
        (option) =>
          option.getAttribute("aria-label") ?? option.innerText.replace(/^\d+\s*/, "").trim(),
      ),
      freeText: Boolean(root.querySelector('[role="textbox"], textarea, input:not([type="file"])')),
    };
  };
  const position = () => {
    const match = root?.innerText.match(/(?:^|\n)(\d+) of (\d+)(?:\n|$)/);
    return match ? { index: Number(match[1]), count: Number(match[2]) } : { index: 1, count: 1 };
  };
  const move = async (direction: "Previous" | "Next") => {
    const before = position().index;
    const button = root?.querySelector<HTMLButtonElement>(
      `button[aria-label="${direction} question"]`,
    );
    if (!button || button.disabled) throw new Error("Cannot browse ChatGPT's questions.");
    button.click();
    const deadline = Date.now() + 5_000;
    do {
      await pause();
      read();
      if (position().index !== before) return;
    } while (Date.now() < deadline);
    throw new Error("ChatGPT did not change questions.");
  };
  while (position().index > 1) await move("Previous");
  const questions: AssistantQuestion[] = [];
  const count = position().count;
  for (let index = 0; index < count; index++) {
    const current = read();
    if (!current.question) throw new Error("Cannot read ChatGPT's question.");
    questions.push(current);
    if (index + 1 < count) await move("Next");
  }
  while (position().index > 1) await move("Previous");
  if (!answers) return questions;
  if (JSON.stringify(questions) !== JSON.stringify(expected)) {
    throw new Error("ChatGPT's questions changed; read the current questions before answering.");
  }
  if (answers.length !== questions.length) throw new Error("Provide one answer per question.");
  for (const [index, answer] of answers.entries()) {
    const question = questions[index]!;
    if (typeof answer === "number") {
      if (!Number.isInteger(answer) || answer < 1 || answer > question.options.length) {
        throw new Error(
          `Question ${index + 1}: choose 1-${question.options.length} or provide free text.`,
        );
      }
    } else if (typeof answer !== "string" || !answer.trim() || !question.freeText) {
      throw new Error(`Question ${index + 1}: a nonempty free-text answer is required.`);
    }
  }
  for (const [index, answer] of answers.entries()) {
    read();
    if (typeof answer === "number") {
      const options = Array.from(root!.querySelectorAll<HTMLElement>('[role="radio"]'));
      if (index + 1 === count) submission.started = true;
      options[answer - 1]!.click();
      if (index + 1 < count) {
        const deadline = Date.now() + 5_000;
        do {
          await pause();
          read();
        } while (position().index === index + 1 && Date.now() < deadline);
        if (position().index !== index + 2)
          throw new Error(`ChatGPT did not accept answer for question ${index + 1}.`);
      }
    } else {
      const input = root!.querySelector<HTMLElement>(
        '[role="textbox"], textarea, input:not([type="file"])',
      );
      if (!input) throw new Error("ChatGPT's free-text input is missing.");
      input.focus();
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        const prototype =
          input instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, answer);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("insertText", false, answer);
      }
      await pause();
      if (
        (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
          ? input.value
          : Array.from(input.children)
              .map((child) => (child.textContent ? (child as HTMLElement).innerText : ""))
              .join("\n")) !== answer
      ) {
        throw new Error(`Could not enter answer for question ${index + 1}.`);
      }
    }
    if (typeof answer === "string" && index + 1 < count) await move("Next");
  }
  // Choice clicks advance/submit natively; a custom answer uses the card's submit button.
  if (typeof answers.at(-1) === "string") {
    const submit = root!.querySelector<HTMLButtonElement>("[data-request-input-skip]");
    if (!submit || submit.disabled || !/^(submit|send|continue)$/i.test(submit.innerText.trim()))
      throw new Error("ChatGPT's answer submit button is not ready.");
    submission.started = true;
    submit.click();
  }
  const deadline = Date.now() + 5_000;
  while (card() && Date.now() < deadline) await pause();
  if (card())
    throw new Error(
      "ChatGPT did not accept the answers; inspect the question card before retrying.",
    );
  return questions;
}

export function buildQuestionCardsExpression(
  answers?: Array<number | string>,
  expected?: AssistantQuestion[],
) {
  // tsx preserves function names with __name; Chrome only needs the function itself.
  const call = `(${questionCards.toString()})(${JSON.stringify(answers) ?? "undefined"}, ${JSON.stringify(expected) ?? "undefined"}, submission)`;
  return `(() => { const __name = (fn) => fn; const submission = { started: false }; return ${answers ? `${call}.then(questions => ({ questions, started: submission.started }), error => ({ error: String(error), started: submission.started }))` : call}; })()`;
}

export async function readAssistantQuestions(Runtime: ChromeClient["Runtime"]) {
  const evaluation = await Runtime.evaluate({
    expression: buildQuestionCardsExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails)
    throw new Error(
      evaluation.exceptionDetails.exception?.description ?? "Cannot read ChatGPT's questions.",
    );
  return Array.isArray(evaluation.result.value) && evaluation.result.value.length > 0
    ? (evaluation.result.value as AssistantQuestion[])
    : null;
}

export async function answerAssistantQuestions(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
  answers: Array<number | string>,
  expected: AssistantQuestion[],
  submissionState = { started: false },
) {
  // A lost transport may have submitted successfully; never replay that attempt automatically.
  submissionState.started = true;
  const evaluation = await Runtime.evaluate({
    expression: buildQuestionCardsExpression(answers, expected),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails)
    throw new Error(
      evaluation.exceptionDetails.exception?.description ?? "Cannot answer ChatGPT's questions.",
    );
  const value = evaluation.result.value as {
    questions: AssistantQuestion[] | null;
    started: boolean;
    error?: string;
  };
  submissionState.started = value.started;
  if (value.error) throw new Error(value.error);
  if (!value.questions) {
    // Native snooze returned 409 in the canary; expired cards need a reply in the same chat.
    const composer = await readComposerSnapshot(Runtime);
    if (composer.activeValue.trim())
      throw new Error(
        "The ChatGPT composer has a draft; clear it before answering expired questions.",
      );
    const prompt = `Answers to your clarification questions:\n\n${expected.map((question, index) => `${index + 1}. ${question.question}\n${typeof answers[index] === "number" ? question.options[(answers[index] as number) - 1] : answers[index]}`).join("\n\n")}\n\nContinue the original request using these answers.`;
    submissionState.started = true;
    await submitPrompt({ runtime: Runtime, input: Input }, prompt, logger);
  }
}
