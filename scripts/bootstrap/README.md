# Standalone bootstrap source

`main.mjs` imports the maintained archive and release-verification modules. Run
`node scripts/build-bootstrap.mjs` to regenerate `scripts/tendriller-bootstrap.mjs`;
the ordinary artifact build does this too. The generated executable can be copied
and run with Node alone, without repository files or installed packages.

Bootstrap checks creation readiness when an origin is supplied and extracts a
bounded kit. `--profile` validates and reports the requested profile; it does not
select/install packages or configure an application. `profileConfigured: false`
and `readiness: "project_prepared"` make that boundary explicit. Existing private
files are preserved, but their presence does not prove initialization, a reachable
participant, or an applied command. Follow the kit's setup and verification steps.
