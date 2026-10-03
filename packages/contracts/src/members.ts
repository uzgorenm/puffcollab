import { MemberId } from "./baseSchemas.ts";

/**
 * The environment owner. Each local Puff Collab server is single-user (its
 * owner and their paired devices); teammates collaborate through the team hub.
 * Thread and message `createdBy`, comment authors, and event `metadata.actor`
 * written by the Stage 1 shared-host mode still decode as `MemberId`s; a
 * missing creator, and this id, mean the owner.
 */
export const OWNER_MEMBER_ID = MemberId.make("owner");
