import { useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { slackRegistrationErrorMessage } from "@paperclipai/shared";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";

/** Uses ordinary request-local state: configuration tokens never enter a query/mutation cache. */
export function SlackAutomaticSetup({ endpoint, stage, disabled, saveDetails, onSaved, onBusy,
  onManual, onContinue, onSaveExit }: {
  endpoint: ChatEndpoint;
  stage: "app" | "credentials";
  disabled: boolean;
  saveDetails: () => Promise<void>;
  onSaved: (endpoint: ChatEndpoint) => void;
  onBusy: (busy: boolean) => void;
  onManual: (existing: boolean) => Promise<void>;
  onContinue: () => void;
  onSaveExit: () => void;
}) {
  const [configurationToken, setConfigurationToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedNoApp, setCheckedNoApp] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const registration = endpoint.setup?.slackRegistration;
  const uncertain = registration?.status === "uncertain";
  const creating = registration?.status === "creating";
  const created = Boolean(registration?.appId);

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { setError(sanitizedSetupErrorMessage(failure, { configurationToken })); }
    finally {
      setConfigurationToken("");
      setBusy(false);
      onBusy(false);
      inFlight.current = false;
    }
  }

  async function create() {
    // Clear the controlled input immediately, including on uncertain network outcomes.
    let token = configurationToken.trim();
    setConfigurationToken("");
    try {
      await saveDetails();
      if (registration?.status === "failed" || checkedNoApp) requestId.current = crypto.randomUUID();
      const next = await chatEndpointsApi.createSlackApp(endpoint.id, {
        requestId: requestId.current,
        credentials: { configurationToken: token },
        ...(checkedNoApp ? { confirmedNoAppCreated: true } : {}),
      });
      setCheckedNoApp(false);
      onSaved(next);
      if (next.setup?.slackRegistration?.appId) onContinue();
    } catch (failure) {
      // A response can be lost after Slack creates the app. Only saved state can advance.
      const current = await chatEndpointsApi.get(endpoint.id).catch(() => null);
      if (current) onSaved(current);
      if (current?.setup?.slackRegistration?.appId) onContinue();
      else throw new Error(sanitizedSetupErrorMessage(failure, { configurationToken: token }));
    } finally { token = ""; }
  }

  return <div className="space-y-5">
    {error || registration?.errorCode ? <p role="alert" className="text-sm text-destructive">
      {error ?? slackRegistrationErrorMessage(registration!.errorCode!)}
    </p> : null}
    {stage === "app" && !created && !creating && <>
      {uncertain && <div className="space-y-3 text-sm">
        <a href={registration?.managementUrl ?? "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Open Slack app settings <ExternalLink className="inline size-3" /></a>
        <label className="flex items-center gap-2">
          <Checkbox checked={checkedNoApp} disabled={busy} onCheckedChange={value => setCheckedNoApp(value === true)} />
          I checked Slack and no app was created. Create a new app.
        </label>
      </div>}
      {(!uncertain || checkedNoApp) && <div className="space-y-2">
        <label htmlFor="slack-configuration-token" className="text-sm font-medium">App configuration token</label>
        <Input id="slack-configuration-token" type="password" autoComplete="off" spellCheck={false}
          value={configurationToken} disabled={busy} onChange={event => setConfigurationToken(event.target.value)}
          aria-describedby="slack-configuration-token-help" />
        <p id="slack-configuration-token-help" className="text-sm text-muted-foreground">
          Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Your App Configuration Tokens → Generate Token</a> in Slack and select your workspace.
          Paste the configuration token here. It applies to that workspace and is used only to create this app, then discarded.
        </p>
      </div>}
    </>}
    {creating && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Creating your Slack app. You can return to this saved setup.</p>}
    {created && <p className="text-sm">
      <strong>{endpoint.setup?.slackApp?.appName ?? "Your Slack app"}</strong> is created.
      {stage === "credentials" && " Approve its installation in Slack. Paperclip will save the credentials and continue here automatically."}
      {registration?.managementUrl && <> <a className="underline underline-offset-4" href={registration.managementUrl} target="_blank" rel="noopener noreferrer">Open Slack app settings <ExternalLink className="inline size-3" /></a></>}
    </p>}
    {stage === "credentials" && registration?.status === "credentials_saved" && <p className="text-sm text-muted-foreground">Your installation credentials are saved. Retry connecting to finish setup.</p>}
    {stage === "app" && <div className="flex flex-wrap gap-4 text-sm">
      <Button variant="link" className="h-auto p-0" disabled={busy || creating} onClick={() => void run(() => onManual(false))}>Create manually</Button>
      <Button variant="link" className="h-auto p-0" disabled={busy || creating} onClick={() => void run(() => onManual(true))}>Use an existing app</Button>
    </div>}
    <SetupWizardFooter onSaveExit={onSaveExit} disabled={busy}>
      {stage === "app" ? <Button disabled={busy || disabled || creating || (!created && (!configurationToken.trim() || uncertain && !checkedNoApp))}
        onClick={() => created ? onContinue() : void run(create)}>
        {busy && <Loader2 className="size-4 animate-spin" />}{created ? "Continue to installation" : "Create Slack app"}
      </Button> : registration?.status === "credentials_saved" ? <Button disabled={busy} onClick={() => void run(async () => onSaved(await chatEndpointsApi.resumeSlackInstallation(endpoint.id)))}>
        {busy && <Loader2 className="size-4 animate-spin" />}Retry connecting
      </Button> : <Button disabled={busy || !created || disabled} onClick={() => void run(async () => {
        const result = await chatEndpointsApi.installSlackApp(endpoint.id);
        // Current-tab navigation avoids popup blockers. The callback resumes this saved draft.
        window.location.assign(result.authorizationUrl);
      })}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}Install in Slack
      </Button>}
    </SetupWizardFooter>
  </div>;
}
