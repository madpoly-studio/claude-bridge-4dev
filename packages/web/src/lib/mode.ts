import { DEMO_QUERY_PARAM } from "../config";

export function isDemoMode(search: string = typeof location !== "undefined" ? location.search : ""): boolean {
  const v = new URLSearchParams(search).get(DEMO_QUERY_PARAM);
  return v !== null && v !== "0" && v !== "false";
}
