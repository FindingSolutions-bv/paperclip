// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackAutomaticSetup } from "./SlackAutomaticSetup";
import type { ChatEndpoint } from "@/api/chatEndpoints";

const api = vi.hoisted(() => ({ createSlackApp: vi.fn(), get: vi.fn(), installSlackApp: vi.fn(), resumeSlackInstallation: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));

describe("automatic Slack setup actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const endpoint: ChatEndpoint = { id: "endpoint", companyId: "company", provider: "slack", status: "draft", assignedAgentId: "agent", assignedAgentName: "Maya", allowUnlinkedPeople: false, setup: { step: "provider_setup", slackSetupMethod: "automatic" } };
  const saved: ChatEndpoint = { ...endpoint, setup: { ...endpoint.setup!, slackRegistration: { status: "install", appId: "AEXAMPLE" } } };
  const onSaved = vi.fn(), onContinue = vi.fn(), onManual = vi.fn(), saveDetails = vi.fn(), onBusy = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear(); sessionStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    api.createSlackApp.mockResolvedValue(saved); api.get.mockResolvedValue(endpoint); saveDetails.mockResolvedValue(undefined);
  });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  function render(value = endpoint, stage: "app" | "credentials" = "app") {
    flushSync(() => root.render(<SlackAutomaticSetup endpoint={value} stage={stage} disabled={false} saveDetails={saveDetails}
      onSaved={onSaved} onContinue={onContinue} onManual={onManual} onBusy={onBusy} onSaveExit={() => {}} />));
  }
  function enter(value: string) {
    const field = container.querySelector("input[type=password]")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!;
    expect(button).toBeDefined(); flushSync(() => button.click());
  }
  it("clears the token, prevents duplicate clicks, and advances only from saved app identity", async () => {
    let complete!: (value: ChatEndpoint) => void;
    api.createSlackApp.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(container.querySelector<HTMLInputElement>("input[type=password]")!.value).toBe("");
    click("Create Slack app"); expect(api.createSlackApp).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    complete(saved); await settle();
    expect(onContinue).toHaveBeenCalledTimes(1); expect(onSaved).toHaveBeenCalledWith(saved);
    expect(saveDetails.mock.invocationCallOrder[0]).toBeLessThan(api.createSlackApp.mock.invocationCallOrder[0]);
    expect(container.innerHTML).not.toContain("configuration-canary");
  });
  it("recovers a lost response by reading saved state without another creation request", async () => {
    api.createSlackApp.mockRejectedValue(new Error("lost response")); api.get.mockResolvedValue(saved);
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(api.createSlackApp).toHaveBeenCalledTimes(1); expect(onContinue).toHaveBeenCalledTimes(1);
  });
  it("redacts error echoes and clears the token when creation fails", async () => {
    api.createSlackApp.mockRejectedValue(new Error("Provider echoed configuration-canary"));
    render(); enter("configuration-canary"); click("Create Slack app"); await settle();
    expect(container.textContent).toContain("[redacted]"); expect(container.innerHTML).not.toContain("configuration-canary");
    expect(onContinue).not.toHaveBeenCalled();
  });
  it("requires an explicit checked-no-app confirmation before retrying an uncertain result", async () => {
    render({ ...endpoint, setup: { ...endpoint.setup!, slackRegistration: { status: "uncertain", errorCode: "slack_creation_uncertain" } } });
    expect(container.querySelector("input[type=password]")).toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    enter("new-token"); click("Create Slack app"); await settle();
    expect(api.createSlackApp.mock.calls[0][1]).toMatchObject({ confirmedNoAppCreated: true });
  });
  it("keeps both manual paths explicit and resumes saved installation credentials", async () => {
    render(); click("Use an existing app"); await settle(); expect(onManual).toHaveBeenCalledWith(true);
    render({ ...saved, setup: { ...saved.setup!, slackRegistration: { status: "credentials_saved", appId: "AEXAMPLE" } } }, "credentials");
    api.resumeSlackInstallation.mockResolvedValue(saved);
    click("Retry connecting"); await settle();
    expect(api.resumeSlackInstallation).toHaveBeenCalledWith("endpoint"); expect(api.createSlackApp).not.toHaveBeenCalled();
  });
});
