// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubChatSetup, submitGitHubAppManifest } from "./GitHubChatSetup";
import { agentsApi } from "@/api/agents";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { copyTextToClipboard } from "@/lib/clipboard";

const fixture = vi.hoisted(() => ({
  agents: [] as any[],
  endpoint: null as any,
  setBreadcrumbs: vi.fn(),
}));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Bot Company",
      issuePrefix: "BOT",
    },
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: fixture.setBreadcrumbs }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));
vi.mock("@/components/SetupWizard", () => ({
  SetupWizardNavigation: () => null,
  SetupWizardFooter: ({ children, onSaveExit }: any) => (
    <footer>
      <button onClick={onSaveExit}>Save &amp; exit</button>
      {children}
    </footer>
  ),
}));
vi.mock("@/components/AgentMultiSelect", () => ({
  AgentSelect: ({ agents, value, onChange }: any) => (
    <select
      aria-label="Agent"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose an agent</option>
      {agents.map((agent: any) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn(), get: vi.fn(), updatePermissions: vi.fn() },
}));
vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: {
    create: vi.fn(),
    get: vi.fn(),
    listResources: vi.fn(),
    setup: vi.fn(),
  },
}));
vi.mock("@/api/githubChat", () => ({
  githubChatApi: {
    advance: vi.fn(),
    registration: vi.fn(),
    saveDraft: vi.fn(),
    startIdentity: vi.fn(),
    confirmIdentity: vi.fn(),
    identity: vi.fn(),
    connectApp: vi.fn(),
    personalConnections: vi.fn(),
  },
}));
vi.mock("@/api/tools", () => ({
  toolsApi: { startCloudConnectorEnrollment: vi.fn() },
}));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

function Location() {
  const location = useLocation();
  return (
    <output>
      {location.pathname}
      {location.search}
    </output>
  );
}

describe("GitHub App wizard", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.agents = [
      {
        id: "reviewer",
        name: "Reviewer",
        status: "idle",
        role: "engineer",
        permissions: { canCreateAgents: true, canCreateSkills: false },
        access: { canAssignTasks: true },
        createdAt: "2026-01-01",
      },
      {
        id: "helper",
        name: "Setup helper",
        status: "idle",
        role: "ceo",
        permissions: {},
        createdAt: "2026-01-01",
      },
      {
        id: "low",
        name: "Low-trust helper",
        status: "idle",
        role: "engineer",
        permissions: { trustPreset: "low_trust_review" },
        createdAt: "2026-01-01",
      },
    ];
    fixture.endpoint = {
      id: "draft-1",
      companyId: "company-1",
      provider: "github",
      assignedAgentId: "reviewer",
      assignedAgentName: "Reviewer",
      status: "draft",
      setup: { github: { stage: "setup" } },
    };
    vi.mocked(agentsApi.list).mockImplementation(async () => fixture.agents);
    vi.mocked(agentsApi.get).mockImplementation(async (id) =>
      fixture.agents.find((agent) => agent.id === id),
    );
    vi.mocked(agentsApi.updatePermissions).mockImplementation(
      async (id, permissions) => {
        fixture.agents = fixture.agents.map((agent) =>
          agent.id === id ? { ...agent, permissions } : agent,
        );
        return fixture.agents.find((agent) => agent.id === id);
      },
    );
    vi.mocked(chatEndpointsApi.get).mockImplementation(
      async () => fixture.endpoint,
    );
    vi.mocked(chatEndpointsApi.create).mockResolvedValue(fixture.endpoint);
    vi.mocked(chatEndpointsApi.listResources).mockResolvedValue([]);
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "create",
    });
    vi.mocked(githubChatApi.saveDraft).mockResolvedValue({ saved: true });
    vi.mocked(githubChatApi.personalConnections).mockResolvedValue([]);
    vi.mocked(copyTextToClipboard).mockResolvedValue();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  it("reconnects the same App using vaulted credentials without requiring another paste", async () => {
    fixture.endpoint.status = "attention";
    fixture.endpoint.botExternalId = "1234";
    vi.mocked(chatEndpointsApi.setup).mockResolvedValue(fixture.endpoint);
    await render("resume=draft-1&reconnect=1");
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reconnect App",
    )!;
    expect(button.disabled).toBe(false);
    expect(container.querySelector("#github-webhook-secret")).toBeNull();
    await act(async () => {
      button.click();
    });
    expect(chatEndpointsApi.setup).toHaveBeenCalledWith("draft-1", {
      action: "reconnect",
    });
    expect(githubChatApi.connectApp).not.toHaveBeenCalled();
  });
  async function render(query = "agentId=reviewer") {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter
            initialEntries={[`/BOT/apps/chat/connect?provider=github&${query}`]}
          >
            <GitHubChatSetup />
            <Location />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await settle();
  }
  async function click(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find(
      (button) =>
        button.textContent === label ||
        button.getAttribute("aria-label") === label,
    );
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
    await settle();
  }
  it("starts with agent selection and saves the low-trust repair before removing its warning", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Choose agent");
    expect(container.textContent).not.toContain("permanent");
    expect(container.textContent).not.toContain("Copy setup prompt");
    await click("Change Reviewer to a low trust agent");
    expect(agentsApi.updatePermissions).toHaveBeenCalledWith(
      "reviewer",
      expect.objectContaining({
        trustPreset: "low_trust_review",
        canCreateAgents: false,
        canCreateSkills: false,
        canAssignTasks: true,
      }),
      "company-1",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("Continue");
    expect(chatEndpointsApi.create).toHaveBeenCalledWith("company-1", {
      provider: "github",
      assignedAgentId: "reviewer",
    });
    expect(container.querySelector("h1")?.textContent).toBe("Connect GitHub");
    expect(container.querySelector("output")?.textContent).toContain(
      "resume=draft-1",
    );
  });
  it("does not offer a new connection while a saved draft cannot be loaded", async () => {
    vi.mocked(chatEndpointsApi.get).mockRejectedValue(new Error("Not found"));
    await render("resume=missing-draft&agentId=reviewer");
    expect(container.textContent).toContain("Could not load this connection");
    expect(container.textContent).not.toContain("Choose agent");
    expect(chatEndpointsApi.create).not.toHaveBeenCalled();
  });
  it("keeps the warning and shows the failure when changing trust fails", async () => {
    vi.mocked(agentsApi.updatePermissions).mockRejectedValueOnce(
      new Error("Permission denied"),
    );
    await render();
    await click("Change Reviewer to a low trust agent");
    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).toContain(
      "Reviewer is not configured for low-trust review",
    );
  });
  it("resumes the assigned draft with only account and App name choices", async () => {
    await render("resume=draft-1");
    expect(container.querySelector("h1")?.textContent).toBe("Connect GitHub");
    expect(container.textContent).toContain("My account");
    expect(container.textContent).toContain("An organization");
    expect(container.textContent).not.toContain("Assign setup task");
    expect(container.textContent).not.toContain("Copy setup prompt");
    expect(container.textContent).not.toContain("Choose setup method");
    expect(
      container.querySelector("input#github-app-name")?.getAttribute("value"),
    ).toBe("Reviewer");
    expect(chatEndpointsApi.create).not.toHaveBeenCalled();
  });
  it("saves ownership and the suggested name when exiting", async () => {
    await render("resume=draft-1");
    const owner = container.querySelector(
      "#github-owner-type",
    ) as HTMLSelectElement;
    await act(async () => {
      owner.value = "organization";
      owner.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = container.querySelector(
      "#github-owner-login",
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "acme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save & exit");
    expect(githubChatApi.saveDraft).toHaveBeenCalledWith("draft-1", {
      name: "Reviewer",
      ownerType: "organization",
      ownerLogin: "acme",
    });
    expect(container.querySelector("output")?.textContent).toBe("/apps");
  });
  it("replaces stale cached form defaults when the saved draft refreshes", async () => {
    await render("resume=draft-1");
    expect(
      (container.querySelector("#github-app-name") as HTMLInputElement).value,
    ).toBe("Reviewer");
    fixture.endpoint = {
      ...fixture.endpoint,
      setup: {
        github: {
          ownerType: "organization",
          ownerLogin: "acme",
          appName: "Saved App",
        },
      },
    };
    await act(async () =>
      client.invalidateQueries({ queryKey: ["github-setup", "draft-1"] }),
    );
    await settle();
    expect(
      (container.querySelector("#github-owner-type") as HTMLSelectElement)
        .value,
    ).toBe("organization");
    expect(
      (container.querySelector("#github-owner-login") as HTMLInputElement)
        .value,
    ).toBe("acme");
    expect(
      (container.querySelector("#github-app-name") as HTMLInputElement).value,
    ).toBe("Saved App");
  });
  it("submits the manifest directly, preserving the bound registration on retry", async () => {
    const registration = {
      registrationUrl:
        "https://github.com/organizations/acme/settings/apps/new?state=bound",
      manifest: { name: "Reviewer", public: false },
      expiresAt: "2026-10-06T20:00:00Z",
    };
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "create",
      registration,
    });
    const submitted: HTMLFormElement[] = [];
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(function (this: HTMLFormElement) {
        submitted.push(this.cloneNode(true) as HTMLFormElement);
      });
    try {
      await render("resume=draft-1");
      await click("Continue to GitHub");
      expect(githubChatApi.registration).not.toHaveBeenCalled();
      expect(submitted[0].method).toBe("post");
      expect(submitted[0].action).toBe(registration.registrationUrl);
      expect(
        (submitted[0].querySelector('[name="manifest"]') as HTMLInputElement)
          .value,
      ).toBe(JSON.stringify(registration.manifest));
      expect(
        (container.querySelector("#github-owner-type") as HTMLSelectElement)
          .disabled,
      ).toBe(true);
      expect(() =>
        submitGitHubAppManifest({
          ...registration,
          registrationUrl: "https://evil.example/apps/new",
        }),
      ).toThrow("invalid registration");
    } finally {
      submit.mockRestore();
    }
  });
  it("shows passive installation progress without a duplicate repository picker or refresh gate", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "install",
      installationUrl: "https://github.com/apps/reviewer/installations/new",
    });
    await render("resume=draft-1");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).not.toContain("I’ve installed it");
    expect(container.textContent).not.toContain("Refresh repositories");
    expect(container.textContent).not.toContain("Prepare registration");
    expect(
      container.querySelector(
        'a[href="https://github.com/apps/reviewer/installations/new"]',
      ),
    ).toBeTruthy();
  });
  it("requires an explicit identity confirmation only for an unlinked account", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "identity",
      identity: { githubUserId: "42", login: "octocat", avatarUrl: null },
    });
    vi.mocked(githubChatApi.confirmIdentity).mockResolvedValue({
      endpointId: "draft-1",
      state: "connected",
    });
    await render("resume=draft-1");
    await click("Confirm my account");
    expect(githubChatApi.confirmIdentity).toHaveBeenCalledWith("draft-1", "42");
    expect(githubChatApi.startIdentity).not.toHaveBeenCalled();
  });
  it("completes automatically while reporting runtime readiness separately", async () => {
    fixture.endpoint = {
      ...fixture.endpoint,
      botLabel: "Actual GitHub Name",
      botUsername: "actual-agent[bot]",
      resources: [{ enabled: true, label: "acme/repo" }],
    };
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "connected",
      runtimeChecks: [
        {
          key: "runtime",
          label: "Runtime",
          ok: false,
          detail: "Configure a runtime before the first review.",
        },
      ],
    });
    await render("resume=draft-1");
    expect(container.querySelector("h1")?.textContent).toBe("GitHub connected");
    expect(container.textContent).toContain("Actual GitHub Name");
    expect(container.textContent).toContain("acme/repo");
    expect(container.textContent).toContain("Configure a runtime");
    expect(container.textContent).not.toContain("Finish");
    await click("Copy mention");
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      "@actual-agent review this pull request",
    );
  });
});
