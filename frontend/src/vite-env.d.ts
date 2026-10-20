/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Release version from the git tag (Dockerfile build arg); unset in dev. */
  readonly VITE_APP_VERSION?: string;
}
