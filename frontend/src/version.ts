// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** App version, baked in at build time: the release workflow passes the git
 *  tag (without the leading "v") as VITE_APP_VERSION to the image build;
 *  local/dev builds show "dev". */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || "dev";
