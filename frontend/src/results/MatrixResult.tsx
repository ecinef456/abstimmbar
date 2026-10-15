// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Results view of a matrix question: the read-only board (descriptions on,
 *  hidden cards dimmed with a marker, legend toggles categories) with the
 *  grouped list below it. */
import { useState } from "react";
import type { MatrixBoard, MatrixSettingsPayload } from "../api";
import Matrix from "./Matrix";
import MatrixList from "./MatrixList";

export default function MatrixResult({
  board,
  settings,
}: {
  board: MatrixBoard;
  settings: MatrixSettingsPayload;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="max-w-3xl">
      <Matrix
        board={board}
        settings={settings}
        mode="results"
        detailed
        hiddenCategories={hidden}
        onToggleCategory={toggle}
      />
      <MatrixList board={board} settings={settings} />
    </div>
  );
}
