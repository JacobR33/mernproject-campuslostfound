import '@testing-library/jest-dom';
window.scrollTo = () => {};
HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
