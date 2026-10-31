import React from "react";
import { Composition, registerRoot } from "remotion";
import { Film, FPS, TOTAL } from "./Film";

const Root: React.FC = () => (
  <Composition id="VoiceMemory" component={Film} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
);
registerRoot(Root);
