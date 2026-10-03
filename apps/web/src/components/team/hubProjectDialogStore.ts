import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

export interface HubProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

interface HubProjectDialogState {
  readonly target: HubProjectTarget | null;
  readonly open: (target: HubProjectTarget) => void;
  readonly close: () => void;
}

/** Which project's "Team hub" dialog is open; the thread menu, palette and project settings open it. */
export const useHubProjectDialogStore = create<HubProjectDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openHubProjectDialog = (target: HubProjectTarget) =>
  useHubProjectDialogStore.getState().open(target);
