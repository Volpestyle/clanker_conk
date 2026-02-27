import React from "react";
export default function Skeleton({ width, height, style }: {
  width?: string;
  height?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="skeleton"
      style={{ width: width || "100%", height: height || "1em", ...style }}
    />
  );
}
