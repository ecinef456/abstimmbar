# SPDX-License-Identifier: Apache-2.0
"""Random player names for game mode without nicknames: "Chaotic Capybara".

The name comes from the phone's anonymous participant token, so the same
phone keeps its name from one game to the next (in the same room).
"""
import hashlib

ADJECTIVES = (
    "Chaotic", "Sleepy", "Fearless", "Curious", "Quantum", "Wobbly", "Cosmic", "Grumpy",
    "Sneaky", "Jolly", "Brave", "Dizzy", "Fuzzy", "Clumsy", "Mighty", "Speedy",
    "Lazy", "Sparkly", "Radiant", "Bouncy", "Witty", "Sassy", "Majestic", "Nervous",
    "Turbo", "Electric", "Magnetic", "Relativistic", "Entangled", "Frictionless", "Spinning",
    "Oscillating", "Caffeinated", "Hungry", "Philosophical", "Dramatic", "Stealthy", "Heroic",
    "Polite", "Suspicious", "Glorious", "Tiny", "Gigantic", "Funky", "Zen", "Lucky",
    "Rebellious", "Elegant", "Excited", "Confused", "Daring", "Peculiar", "Sophisticated",
    "Cheeky", "Gentle", "Wild", "Noble", "Loud", "Silent", "Shiny", "Fluffy", "Groovy",
    "Epic", "Humble", "Radioactive", "Supersonic", "Tangential", "Weightless",
)
ANIMALS = (
    "Capybara", "Axolotl", "Platypus", "Otter", "Penguin", "Narwhal", "Llama", "Wombat",
    "Koala", "Panda", "Sloth", "Hedgehog", "Flamingo", "Lemur", "Meerkat", "Quokka",
    "Raccoon", "Walrus", "Badger", "Beaver", "Chameleon", "Dolphin", "Gecko", "Giraffe",
    "Hamster", "Ibex", "Jaguar", "Kiwi", "Lynx", "Mongoose", "Ocelot", "Octopus",
    "Pelican", "Puffin", "Seal", "Tapir", "Toucan", "Turtle", "Yak", "Zebra",
    "Alpaca", "Armadillo", "Bison", "Cheetah", "Corgi", "Dingo", "Ferret", "Fox",
    "Gorilla", "Hippo", "Kangaroo", "Lobster", "Manatee", "Moose", "Owl", "Parrot",
    "Rabbit", "Salamander", "Squirrel", "Tiger", "Chinchilla", "Pangolin", "Marmot", "Hedgehog",
)
ANIMALS = tuple(dict.fromkeys(ANIMALS))  # no duplicates
COMBINATIONS = len(ADJECTIVES) * len(ANIMALS)


def name_at(index):
    index %= COMBINATIONS
    return f"{ADJECTIVES[index % len(ADJECTIVES)]} {ANIMALS[index // len(ADJECTIVES)]}"


def for_token(key, taken=()):
    """The phone's name, or the next free one if someone in the game has it."""
    start = int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big")
    taken = {name.lower() for name in taken}
    for step in range(COMBINATIONS):
        name = name_at(start + step * 7919)  # a prime stride spreads the fallbacks
        if name.lower() not in taken:
            return name
    return name_at(start)
