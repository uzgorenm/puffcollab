import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { useProject } from "../../state/entities";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { HubProjectPeoplePanel } from "./HubProjectDialog";
import { useProjectPeopleDialogStore } from "./projectPeopleDialogStore";

/**
 * The project's people on the team hub: members, Remove and Leave, invitations
 * by GitHub login, and the hub link. Opened from the thread menu, Team overview,
 * the command palette, and project settings.
 */
export function ProjectPeopleDialogHost() {
  const target = useProjectPeopleDialogStore((state) => state.target);
  const close = useProjectPeopleDialogStore((state) => state.close);
  const project = useProject(
    target === null ? null : scopeProjectRef(target.environmentId, target.projectId),
  );
  if (target === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>People in {project?.title ?? "this project"}</DialogTitle>
          <DialogDescription>
            Invite teammates to the hub project by GitHub login. They join once they accept.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <HubProjectPeoplePanel
            environmentId={target.environmentId}
            projectId={target.projectId}
            onNavigate={close}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
