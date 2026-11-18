// Notice-only post-install hook for the @codedealer/pi-sync package.
//
// It prints a reminder to rerun the user's usual bootstrap command so the
// setup repository picks up the bundled pi-sync skill and extension shipped
// with the installed package. It must stay notice-only: no filesystem,
// network, setup-repository, or Pi installation access, and it never invokes
// bootstrap. Package managers may require approval for or suppress lifecycle
// scripts, so the manual rerun documented in the README remains the reliable
// step.

console.log([
  'pi-sync is installed.',
  '',
  'To refresh the bundled pi-sync skill and extension in your setup',
  'repository, rerun your usual bootstrap command, for example:',
  '',
  '  pi-sync bootstrap --repo-url <your-setup-repository-url>',
  '',
  'This notice is informational only. It did not modify any files and does',
  'not run bootstrap. If your package manager suppressed this lifecycle',
  'script, the manual rerun above is the reliable step.',
].join('\n'));