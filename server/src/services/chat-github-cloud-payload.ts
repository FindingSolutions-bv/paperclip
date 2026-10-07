const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Explicit, bounded provider fields; never persist the original webhook body. */
export function normalizeGitHubBotCloudPayload(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    action: 100,
    before: 64,
    zen: 300,
    sender: { id: true, login: 100, type: 40 },
    repository: {
      id: true,
      full_name: 300,
      name: 100,
      owner: { id: true, login: 100, type: 40 },
    },
    installation: {
      id: true,
      app_id: true,
      account: { id: true, login: 100, type: 40 },
      repository_selection: 40,
    },
    issue: {
      id: true,
      number: true,
      title: 1_000,
      body: 24_000,
      html_url: 2_000,
      user: { id: true, login: 100, type: 40 },
      pull_request: { url: 2_000, html_url: 2_000 },
    },
    comment: {
      id: true,
      body: 24_000,
      html_url: 2_000,
      created_at: 100,
      updated_at: 100,
      user: { id: true, login: 100, type: 40 },
      in_reply_to_id: true,
      path: 1_000,
      line: true,
      original_line: true,
      diff_hunk: 8_000,
    },
    pull_request: {
      id: true,
      number: true,
      title: 1_000,
      body: 24_000,
      html_url: 2_000,
      state: 40,
      draft: true,
      merged: true,
      merged_at: 100,
      updated_at: 100,
      user: { id: true, login: 100, type: 40 },
      head: { sha: 64, ref: 300 },
      base: { sha: 64, ref: 300 },
      labels: [{ name: 100 }],
    },
    repositories_added: [{ id: true, full_name: 300, name: 100 }],
    repositories_removed: [{ id: true, full_name: 300, name: 100 }],
    repositories: [{ id: true, full_name: 300, name: 100 }],
  };
  function select(value: unknown, shape: unknown): unknown {
    if (shape === true)
      return typeof value === "boolean" ||
        (typeof value === "number" && Number.isSafeInteger(value)) ||
        (typeof value === "string" && /^[1-9][0-9]{0,30}$/.test(value))
        ? value
        : undefined;
    if (typeof shape === "number")
      return value === null
        ? null
        : typeof value === "string"
          ? value.slice(0, shape)
          : undefined;
    if (Array.isArray(shape))
      return Array.isArray(value)
        ? value
            .slice(0, 1_000)
            .map((item) => select(item, shape[0]))
            .filter((item) => item !== undefined)
        : undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const source = record(value);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record(shape))) {
      const result = select(source[key], child);
      if (result !== undefined) output[key] = result;
    }
    return output;
  }
  return record(select(body, schemas));
}
