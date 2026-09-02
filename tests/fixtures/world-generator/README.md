# World Generator fixtures

`legal-clinic-scenario.md` is an original scenario description written for the
World Generator tests. It deliberately mixes three kinds of content:

1. the scenario a user would actually describe (a small legal aid clinic, its
   working loop, its rules and its team);
2. a prompt-injection paragraph that tries to talk to the analyzer directly;
3. a code block and shell text.

All of it is untrusted Markdown input. The tests assert that (2) and (3) never
reach a world rule, a workflow step, a terminology slot or a cast persona, and
that nothing in the file is treated as a host instruction, a Skill grant, a
package id or a path.
