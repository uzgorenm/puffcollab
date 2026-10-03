import type { AdvertisedEndpoint, EnvironmentId } from "@t3tools/contracts";
import { memberSignInUrl } from "@t3tools/client-runtime/state/members";
import { useMemo } from "react";

import {
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "~/state/environments";
import { desktopNetworkAccessStateAtom } from "~/state/desktopNetworkAccess";
import { useEnvironmentQuery } from "~/state/query";
import { useUiStateStore } from "~/uiStateStore";
import {
  isTailscaleHttpsEndpoint,
  resolveHostedPairingUrl,
  resolveShareablePairingUrl,
} from "../settings/pairingUrls";

/** Builds the link a teammate opens to sign in; null when only the code can be shared. */
export type SignInUrlResolver = (credential: string) => string | null;

const NO_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

/**
 * The T3 Connect address of this environment, when the client knows it. Its
 * HTTPS tunnel is reachable from anywhere, so a teammate can sign in through
 * the hosted app without being on the host's network.
 */
export function useConnectSignInUrl(environmentId: EnvironmentId | null): SignInUrlResolver | null {
  const discovery = useRelayEnvironmentDiscovery();
  const httpBaseUrl =
    environmentId === null
      ? undefined
      : discovery.environments.get(environmentId)?.environment.endpoint.httpBaseUrl;
  return useMemo(
    () =>
      httpBaseUrl === undefined
        ? null
        : (credential: string) => resolveHostedPairingUrl(httpBaseUrl, credential),
    [httpBaseUrl],
  );
}

/**
 * Sign-in links for people invited to an environment, from any client. On
 * the desktop's own environment they use the address chosen for pairing
 * links (like Settings → Connections); elsewhere, the address this client
 * reaches the host at; failing both, the T3 Connect tunnel.
 */
export function useSignInUrlResolver(environmentId: EnvironmentId | null): SignInUrlResolver {
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const desktopBridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const desktop = useEnvironmentQuery(
    isPrimary && desktopBridge ? desktopNetworkAccessStateAtom : null,
  ).data;
  const defaultEndpointKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const connect = useConnectSignInUrl(environmentId);

  return useMemo(() => {
    const exposure = desktop?.serverExposureState;
    const endpoints = (desktop?.advertisedEndpoints ?? NO_ENDPOINTS).filter(
      (endpoint) => exposure?.mode === "network-accessible" || isTailscaleHttpsEndpoint(endpoint),
    );
    return (credential: string) =>
      (isPrimary
        ? resolveShareablePairingUrl({
            credential,
            endpoints,
            defaultEndpointKey,
            endpointUrl: exposure?.endpointUrl,
          })
        : null) ??
      memberSignInUrl(httpBaseUrl, credential) ??
      connect?.(credential) ??
      null;
  }, [connect, defaultEndpointKey, desktop, httpBaseUrl, isPrimary]);
}
