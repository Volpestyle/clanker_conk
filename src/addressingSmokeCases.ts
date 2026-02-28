export const ADDRESSING_SMOKE_CASES = [
  { text: "Clanker go tell the silly boys in vc to go to bed", expected: true },
  { text: "Yo, what's up, Clink?", expected: true },
  { text: "yo plink", expected: true },
  { text: "hi clunky", expected: true },
  { text: "is that u clank?", expected: true },
  { text: "is that you clinker?", expected: true },
  { text: "did i just hear a clanka?", expected: true },
  { text: "blinker conk.", expected: true },
  { text: "I love the clankers of the world", expected: true },
  { text: "i pulled a prank on him!", expected: false },
  { text: "pranked ya", expected: false },
  { text: "get pranked", expected: false },
  { text: "get stanked", expected: false },
  { text: "its stinky in here", expected: false }
];
