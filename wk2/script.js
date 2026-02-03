/*
  Data fetch script. Uses Fetch to get a text file
  every five seconds, and fill its contents into 
  a div on the HTML page. 

  Based on my fetch example (https://tigoe.github.io/html-for-conndev/fetch/). 

  created 30 Dec 2022
  by Tom Igoe
*/

// this function is called once on page load (see below):
let url = 'https://en.wikipedia.org/w/api.php?action=parse&page=Rat&format=json&origin=*'
let sensorData = [];

function setup() {
  generateDivContent(url);
  // set an interval to run fetchText() every 5 seconds:
  setInterval(fetchText, 1000);
}


// make an HTTP call to get a text file:
function fetchText() {
  // parameters for the HTTP/S call
  let params = {
    mode: 'cors', // if you need to turn off CORS, use no-cors
    headers: {    // any HTTP headers you want can go here
      'accept': 'application/text'
    }
  }
  // make the HTTP/S call:
  fetch('log.json', params)
    .then(response => response.text())  
    .then(data => getResponse(data))    // get the body of the response
    .catch(error => getResponse(error));// if there is an error
}

// function to call when you've got something to display:
function getResponse(data) {
  // ensure we have a string (errors or objects may be passed here)
  const textData = (typeof data === 'string') ? data : (data && data.message) ? String(data.message) : String(data);
  // extract last non-empty line from the response text
  const lines = textData.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  const lastLine = lines.length ? lines[lines.length - 1] : '';  

  if (!lastLine) return;
  // try to parse JSON, but handle non-JSON lines gracefully
  let result;
  try {
    result = JSON.parse(lastLine);
    sensorData.push({ sensor: result.sensor, timestamp: Date.now() });
    console.log('Parsed sensor data:', sensorData[sensorData.length - 1]);
  } catch (err) {
    console.warn('getResponse: lastLine is not valid JSON, skipping parse:', lastLine);
    return;
  }
  draw(result.device, result.sensor);
}

function draw(name, sensor) {
  const hole = document.getElementById('hole');
  if (!hole) return;

  // robustly handle numeric or {x,y} sensor formats
  const { gx, gy, gz, ax, ay, az } = sensor;
  // get the direction of the angle by calculating difference of gyrometer values ?
  
  console.log(`Sensor data - gx: ${gx}, gy: ${gy}, gz: ${gz}, ax: ${ax}, ay: ${ay}, az: ${az}`);
}

function generateDivContent(url) {
  fetch(url)
    .then(response => response.json())
    .then(data => {
      console.log(data)
      const html = data.parse.text['*'];
      document.getElementById('content').innerHTML = html;
    })

}
// This is a listener for the page to load.
// This is the command that actually starts the script:
window.addEventListener('DOMContentLoaded', setup);

// UTILS
function map(value, in_min, in_max, out_min, out_max) {
  return (value - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}