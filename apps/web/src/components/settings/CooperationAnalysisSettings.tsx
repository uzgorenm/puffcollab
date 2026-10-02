import { isCooperationAnalysisDriverSupported } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Which provider instance runs Puff Collab cooperation analysis. Off by
 * default. Only drivers that can run a tool-free helper are offered; see
 * `COOPERATION_ANALYSIS_DRIVER_SUPPORT`.
 */
export function CooperationAnalysisSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  ).filter((entry) => isCooperationAnalysisDriverSupported(entry.driverKind));
  const usable = instanceEntries.filter((entry) => entry.enabled && entry.isAvailable);
  const selection = settings.cooperationAnalysisModelSelection;
  const fallback = usable[0];
  const active =
    selection ??
    (fallback ? createModelSelection(fallback.instanceId, fallback.models[0]?.slug ?? "") : null);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    active?.instanceId ?? null,
    active?.model ?? null,
  );

  return (
    <SettingsSection title="Cooperation analysis">
      <SettingsRow
        serverScoped
        settingKeys={["cooperationAnalysisModelSelection"]}
        title="Analysis model"
        description="Summarizes shared threads whose owners opted in and notes related work for them. Runs as text only, with no tools. Supported: Claude, OpenCode, Antigravity."
        control={
          connectedEnvironments.length === 0 ? (
            <span className="text-sm text-muted-foreground">Connect an environment first.</span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {selection !== null ? (
                <ProviderModelPicker
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  triggerAriaLabel="Cooperation analysis model"
                  onInstanceModelChange={(instanceId, model) =>
                    updateSettings({
                      cooperationAnalysisModelSelection: createModelSelection(instanceId, model),
                    })
                  }
                />
              ) : usable.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  No supported provider is available.
                </span>
              ) : null}
              <Switch
                checked={selection !== null}
                disabled={selection === null && (active === null || active.model === "")}
                onCheckedChange={(checked) =>
                  updateSettings({
                    cooperationAnalysisModelSelection: checked ? active : null,
                  })
                }
                aria-label="Run cooperation analysis"
              />
            </div>
          )
        }
      />
    </SettingsSection>
  );
}
