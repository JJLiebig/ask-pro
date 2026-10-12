import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "./atomicWrite.js";
import type { AssistantQuestion } from "../browser/actions/questions.js";

export interface AskProQuestions {
  requestId: string;
  questions: AssistantQuestion[];
}

export async function readAskProQuestions(sessionDir: string): Promise<AskProQuestions> {
  return JSON.parse(await fs.readFile(path.join(sessionDir, "QUESTIONS.json"), "utf8"));
}

export async function writeAskProQuestions(sessionDir: string, questions: AssistantQuestion[]) {
  const previous = await readAskProQuestions(sessionDir).catch(() => null);
  const request = {
    requestId:
      previous && JSON.stringify(previous.questions) === JSON.stringify(questions)
        ? previous.requestId
        : randomUUID(),
    questions,
  };
  await atomicWriteFile(
    path.join(sessionDir, "QUESTIONS.json"),
    `${JSON.stringify(request, null, 2)}\n`,
  );
}

export function parseQuestionAnswers(
  raw: string,
  request: AskProQuestions,
): Array<number | string> {
  const value = JSON.parse(raw);
  if (value?.requestId !== request.requestId)
    throw new Error(
      "Answers belong to a different question request; read the current QUESTIONS.json.",
    );
  if (!Array.isArray(value.answers) || value.answers.length !== request.questions.length) {
    throw new Error("Provide one answer per question in answers, in question order.");
  }
  for (const [index, answer] of value.answers.entries()) {
    const question = request.questions[index]!;
    if (
      typeof answer === "number" &&
      Number.isInteger(answer) &&
      answer >= 1 &&
      answer <= question.options.length
    )
      continue;
    if (typeof answer === "string" && answer.trim() && question.freeText) continue;
    throw new Error(
      `Question ${index + 1}: choose a numbered option or provide nonempty free text.`,
    );
  }
  return value.answers;
}
