import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ProjectPeopleTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

interface ProjectPeopleDialogState {
  readonly target: ProjectPeopleTarget | null;
  readonly open: (target: ProjectPeopleTarget) => void;
  readonly close: () => void;
}

/** Which project's People dialog is open; any entry point can open it. */
export const useProjectPeopleDialogStore = create<ProjectPeopleDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openProjectPeopleDialog = (target: ProjectPeopleTarget) =>
  useProjectPeopleDialogStore.getState().open(target);
