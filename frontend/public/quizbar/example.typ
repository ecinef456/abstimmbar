#import "quizbar.typ": *
#show: quizbar.with(
  title: "Week 3 – Quiz 1",
  type: "live",
  description: [In-class quiz about waves and oscillations],
  figures: "figures",
)

#question(
  [Speed of a wave with wavelength $lambda = 2$ m and frequency $f = 3$ Hz?],
  kind: "SC",
  answers: (
    answer(true, [6 m/s], why: [$v = lambda f = 2 dot 3$ m/s.]),
    answer(false, [1.5 m/s], why: [That is $lambda \/ f$, which has units of $"m" dot "s"$.]),
    answer(false, [0.67 m/s], why: [That is $f \/ lambda$.]),
  ),
  image: "wave.png",
  tags: ("waves", "week-3"),
  time-limit-s: 60,
)

#question(
  [Which of these quantities are *conserved* for an ideal spring–mass oscillator without friction?],
  kind: "MC",
  answers: (
    answer(true, [Total energy $E = 1/2 k x^2 + 1/2 m v^2$], why: [No friction, so no energy leaves the system.]),
    answer(false, [Kinetic energy], why: [It is converted into potential energy and back.]),
    answer(true, [The period $T = 2 pi sqrt(m \/ k)$], why: [It does not depend on the amplitude.]),
    answer(false, [The momentum $p = m v$], why: [The spring force changes it all the time.]),
  ),
  tags: ("oscillations", "week-3"),
  shuffle: true,
)

#question(
  [Doubling the mass $m$ of a spring pendulum changes its frequency by a factor of …],
  answers: (
    answer(false, [$2$], why: [Frequency goes _down_ with mass.]),
    answer(true, [$1 \/ sqrt(2)$], why: [$f prop 1 \/ sqrt(m)$.]),
    answer(false, [$1 \/ 2$], why: [The square root is missing.]),
  ),
  tags: "oscillations",
)
