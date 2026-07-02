import type { Task } from "../schemas.js";

export function taskResultKeys(task: Pick<Task, "create_path" | "oracles">): string[] {
  const keys = new Set<string>(["gid"]);
  const scan = (template: string | undefined) => {
    if (!template) return;
    for (const match of template.matchAll(/\{([^}]+)\}/g)) {
      const key = match[1];
      if (key && key !== "gid") keys.add(key);
    }
  };
  scan(task.create_path);
  for (const oracle of task.oracles) scan(oracle.readPathTemplate);
  return [...keys];
}

export function taskResultShape(task: Pick<Task, "id" | "create_path" | "oracles">): string {
  const fields = taskResultKeys(task)
    .map((key) => `"${key}": "<${key} or null>"`)
    .join(", ");
  return `      "${task.id}": {${fields}}`;
}
