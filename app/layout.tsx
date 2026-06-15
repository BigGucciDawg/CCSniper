export const metadata = {
  title: "cc-sniper",
  description: "Collector Crypt below-insured deal scanner",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          background: "#0b0b0c",
          color: "#e6e6e6",
          margin: 0,
          padding: "2rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}
