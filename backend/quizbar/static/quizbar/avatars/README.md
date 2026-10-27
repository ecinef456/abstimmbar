# Game avatars — add your own pictures

The 30 physicists (`<slug>.svg`) are built in. Put your own images in
**this folder**; they are not in git, so each server keeps its own.

| File                         | Effect                                                     |
|------------------------------|------------------------------------------------------------|
| `newton-full.png`            | full-body picture of Newton: big on the phone once chosen, and on the podium |
| `newton.png`                 | replaces Newton's head icon in the picker                  |
| `ada-lovelace.png`           | a new avatar "Ada Lovelace" (name from the file name)       |
| `ada-lovelace-full.png`      | …and its full-body picture                                 |

PNG, WebP or JPG (transparent PNG looks best). Icons: square, about
256×256, just the head. Full body: portrait, e.g. 600×1000.

Built-in slugs: newton, einstein, curie, feynman, noether, bohr, heisenberg,
schrodinger, dirac, maxwell, faraday, tesla, galileo, kepler, planck, pauli,
fermi, meitner, rutherford, hawking, boltzmann, wu, hubble, rubin, bose,
raman, yukawa, archimedes, huygens, kelvin.

On the server, copy into **both** checkouts and rebuild:

```bash
cp ~/avatars/*.png /opt/abstimmbar-test/backend/quizbar/static/quizbar/avatars/
cp ~/avatars/*.png /opt/abstimmbar/backend/quizbar/static/quizbar/avatars/
/opt/abstimmbar-test/fork/test-up.sh      # test instance
/opt/abstimmbar/fork/deploy.sh            # live site
```
