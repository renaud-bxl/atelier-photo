const vertex=`#version 300 es
precision highp float;
in vec2 position;in vec2 uv;out vec2 coordinates;
uniform sampler2D depthMap;uniform vec2 angles;uniform float strength;uniform float aspect;
void main(){
  float depth=texture(depthMap,uv).r;
  vec3 p=vec3(position.x*aspect,position.y,(depth-.5)*strength);
  float c=cos(angles.x),s=sin(angles.x);p=vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);
  c=cos(angles.y);s=sin(angles.y);p=vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z);
  float eye=3.-p.z;
  gl_Position=vec4(p.x/aspect*3.,p.y*3.,(10.1/9.9)*eye-(2./9.9),eye);
  coordinates=uv;
}`;
const fragment=`#version 300 es
precision highp float;in vec2 coordinates;out vec4 color;
uniform sampler2D photograph;uniform sampler2D depthMap;uniform bool showDepth;
void main(){float d=texture(depthMap,coordinates).r;color=showDepth?vec4(d,d,d,1.):texture(photograph,coordinates);}`;

export function createSpatialRenderer(canvas,image,depth){
  const gl=canvas.getContext('webgl2',{alpha:false,antialias:true,preserveDrawingBuffer:true});
  if(!gl)throw new Error('La vue spatiale nécessite un affichage WebGL 2 compatible.');
  const resources=[];
  const shader=(kind,source)=>{const value=gl.createShader(kind);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error('Le rendu spatial n’a pas pu démarrer.');resources.push(()=>gl.deleteShader(value));return value;};
  const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Le rendu spatial n’a pas pu démarrer.');
  resources.push(()=>gl.deleteProgram(program));gl.useProgram(program);
  const cols=192,rows=128,vertices=new Float32Array((cols+1)*(rows+1)*4),indices=new Uint16Array(cols*rows*6);
  for(let row=0;row<=rows;row++)for(let col=0;col<=cols;col++){
    const i=(row*(cols+1)+col)*4;vertices.set([col/cols*2-1,1-row/rows*2,col/cols,row/rows],i);
  }
  let cursor=0;for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){const i=row*(cols+1)+col;indices.set([i,i+cols+1,i+1,i+1,i+cols+1,i+cols+2],cursor);cursor+=6;}
  for(const [target,values] of [[gl.ARRAY_BUFFER,vertices],[gl.ELEMENT_ARRAY_BUFFER,indices]]){const buffer=gl.createBuffer();gl.bindBuffer(target,buffer);gl.bufferData(target,values,gl.STATIC_DRAW);resources.push(()=>gl.deleteBuffer(buffer));}
  for(const [name,offset] of [['position',0],['uv',8]]){const location=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,16,offset);}
  function texture(unit,name,upload){const item=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,item);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);upload();gl.uniform1i(gl.getUniformLocation(program,name),unit);resources.push(()=>gl.deleteTexture(item));}
  texture(0,'photograph',()=>gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image));
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  texture(1,'depthMap',()=>gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,depth.width,depth.height,0,gl.RED,gl.UNSIGNED_BYTE,depth.pixels));
  const uniforms=Object.fromEntries(['angles','strength','aspect','showDepth'].map(name=>[name,gl.getUniformLocation(program,name)]));
  gl.enable(gl.DEPTH_TEST);gl.clearColor(.055,.065,.085,1);
  return {
    isContextLost:()=>gl.isContextLost(),
    draw({yaw=0,pitch=0,strength=.5,showDepth=false}={}){
      gl.viewport(0,0,canvas.width,canvas.height);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(program);
      gl.uniform2f(uniforms.angles,yaw*Math.PI/180,pitch*Math.PI/180);gl.uniform1f(uniforms.strength,strength);gl.uniform1f(uniforms.aspect,canvas.width/canvas.height);gl.uniform1i(uniforms.showDepth,showDepth);
      gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
    },
    destroy(){for(const dispose of resources)dispose();gl.getExtension('WEBGL_lose_context')?.loseContext();}
  };
}
