import type { AdvertisedEndpoint } from "@t3tools/contracts";

import { isLoopbackHostname } from "~/environments/primary";
import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

/**
 * The link another device or a teammate opens to pair with this environment:
 * the chosen advertised endpoint, else the desktop's exposed endpoint, else
 * this page's own origin when another machine can reach it. Null means only
 * the raw code can be shared (for example the desktop app with network access
 * off, whose page is not served over HTTP).
 */
export function resolveShareablePairingUrl(input: {
  readonly credential: string | undefined;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
  readonly endpointUrl: string | null | undefined;
}): string | null {
  const { credential, endpointUrl } = input;
  if (!credential) return null;
  const endpoint = selectPairingEndpoint(input.endpoints, input.defaultEndpointKey);
  if (endpoint) return resolveAdvertisedEndpointPairingUrl(endpoint, credential);
  if (endpointUrl != null && endpointUrl !== "") {
    return (
      resolveHostedPairingUrl(endpointUrl, credential) ??
      resolveDesktopPairingUrl(endpointUrl, credential)
    );
  }
  const { protocol, hostname } = window.location;
  return (protocol === "http:" || protocol === "https:") && !isLoopbackHostname(hostname)
    ? resolveCurrentOriginPairingUrl(credential)
    : null;
}
