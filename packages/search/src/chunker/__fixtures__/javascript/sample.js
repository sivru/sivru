const PI = 3.14159;

function area(r) {
  return PI * r * r;
}

const square = (n) => n * n;

class Shape {
  constructor(name) {
    this.name = name;
  }

  describe() {
    return `shape:${this.name}`;
  }
}

module.exports = { area, square, Shape };
