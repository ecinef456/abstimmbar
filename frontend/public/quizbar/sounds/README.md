# Game-mode sounds (your own files)

Put your own MP3 files here; they are **not** in git (see `.gitignore`), so
each server keeps its own. The beamer plays them in game mode; a missing
file just stays silent. **M** (or the speaker button) mutes.

| File              | When                                            | Plays     |
|-------------------|-------------------------------------------------|-----------|
| `lobby.mp3`       | start screen with the QR code                   | loop      |
| `question.mp3`    | while a question is open (countdown music)      | loop      |
| `reveal.mp3`      | the results appear                              | once      |
| `leaderboard.mp3` | the leaderboard opens (**P**)                   | once      |
| `drumroll.mp3`    | podium, before the winner is revealed (~3 s)    | loop      |
| `podium.mp3`      | podium, the winner appears                      | once      |

Use music you are allowed to play in class (your own, or a licence that
allows it, e.g. CC0 / royalty-free libraries).

On the server, copy the files into **both** checkouts, then rebuild:

```bash
cp ~/sounds/*.mp3 /opt/abstimmbar-test/frontend/public/quizbar/sounds/
cp ~/sounds/*.mp3 /opt/abstimmbar/frontend/public/quizbar/sounds/
/opt/abstimmbar-test/fork/test-up.sh      # test instance
/opt/abstimmbar/fork/deploy.sh            # live site
```
