import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SlackSetupFixture } from "../fixtures/SlackSetupFixture";

const meta = {
  title: "Connections/Slack/Automatic setup",
  component: SlackSetupFixture,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/apps/chat/connect?provider=slack&purpose=chat&resume=slack-story"],
    docs: { description: { component: "The production seven-step wizard with controlled provider responses. Enter any synthetic configuration token, create the app, install, and simulate the signed verification to continue through avatar, explicit identity linking, and the optional test. No live provider proof is implied." } } },
  render: args => <SlackSetupFixture key={args.scenario} {...args} />,
} satisfies Meta<typeof SlackSetupFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AutomaticJourney: Story = { args: { scenario: "create" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByLabelText("App configuration token"), "synthetic-preview-token");
  await userEvent.click(canvas.getByRole("button", { name: /^Create Slack app$/ }));
  await expect(await canvas.findByRole("heading", { name: "Install Slack app" })).toBeVisible();
} };
export const ManualFallback: Story = { args: { scenario: "manual" } };
export const InstallationPending: Story = { args: { scenario: "install" } };
export const InstallationDeclined: Story = { args: { scenario: "declined" } };
export const UncertainCreation: Story = { args: { scenario: "uncertain" } };
export const SavedCredentialsRecovery: Story = { args: { scenario: "recovery" } };
export const VerificationWaiting: Story = { args: { scenario: "verify" } };
export const Mobile: Story = { args: { scenario: "create" }, globals: { viewport: { value: "mobile1", isRotated: false } } };
